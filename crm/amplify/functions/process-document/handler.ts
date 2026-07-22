import type { S3Handler } from "aws-lambda";
import {
  TextractClient,
  StartDocumentAnalysisCommand,
  GetDocumentAnalysisCommand,
  type Block,
} from "@aws-sdk/client-textract";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import type { Schema } from "../../data/resource";

/**
 * Textract OCR pipeline.
 *
 * Fires on every upload to the crmDocuments bucket. Keys are expected to be
 *   documents/{entityType}/{entityId}/{documentId}/{filename}
 * — the documentId segment links the S3 object back to its Document record.
 * Anything else (e.g. certificates/) is ignored.
 */

const textract = new TextractClient();

// Textract supports PDF, TIFF, PNG, JPEG.
const OCR_EXTENSIONS = new Set(["pdf", "png", "jpg", "jpeg", "tif", "tiff"]);

// DynamoDB items cap at 400KB; leave headroom for the rest of the record.
const MAX_TEXT_CHARS = 250_000;
const MAX_TABLES_CHARS = 100_000;

const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_MS = 13 * 60 * 1000; // stay under the 15 min Lambda timeout

let dataClient: ReturnType<typeof generateClient<Schema>> | undefined;

async function getDataClient() {
  if (!dataClient) {
    // Env vars are injected by `allow.resource(processDocument)` in the schema.
    const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(
      process.env as never
    );
    Amplify.configure(resourceConfig, libraryOptions);
    dataClient = generateClient<Schema>();
  }
  return dataClient;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runTextract(bucket: string, key: string): Promise<Block[]> {
  const start = await textract.send(
    new StartDocumentAnalysisCommand({
      DocumentLocation: { S3Object: { Bucket: bucket, Name: key } },
      FeatureTypes: ["TABLES"],
    })
  );
  const jobId = start.JobId!;

  const deadline = Date.now() + MAX_POLL_MS;
  const blocks: Block[] = [];
  let nextToken: string | undefined;

  // Wait for the job, then drain all result pages.
  for (;;) {
    const res = await textract.send(
      new GetDocumentAnalysisCommand({ JobId: jobId, NextToken: nextToken })
    );
    if (res.JobStatus === "IN_PROGRESS") {
      if (Date.now() > deadline) throw new Error("Textract job timed out");
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    if (res.JobStatus === "FAILED") {
      throw new Error(res.StatusMessage ?? "Textract job failed");
    }
    blocks.push(...(res.Blocks ?? []));
    if (!res.NextToken) break;
    nextToken = res.NextToken;
  }
  return blocks;
}

/** Flatten LINE blocks into readable text, page by page. */
function extractText(blocks: Block[]): string {
  const lines: string[] = [];
  let page = 0;
  for (const block of blocks) {
    if (block.BlockType === "PAGE") {
      page += 1;
      if (page > 1) lines.push(`\n--- page ${page} ---\n`);
    } else if (block.BlockType === "LINE" && block.Text) {
      lines.push(block.Text);
    }
  }
  return lines.join("\n");
}

/** Rebuild TABLE blocks into 2D string arrays (budgets, dues-per-unit, etc.). */
function extractTables(blocks: Block[]): string[][][] {
  const byId = new Map(blocks.map((b) => [b.Id!, b]));

  const cellText = (cell: Block): string => {
    const words: string[] = [];
    for (const rel of cell.Relationships ?? []) {
      if (rel.Type !== "CHILD") continue;
      for (const id of rel.Ids ?? []) {
        const child = byId.get(id);
        if (child?.BlockType === "WORD" && child.Text) words.push(child.Text);
        if (child?.BlockType === "SELECTION_ELEMENT")
          words.push(child.SelectionStatus === "SELECTED" ? "[x]" : "[ ]");
      }
    }
    return words.join(" ");
  };

  const tables: string[][][] = [];
  for (const block of blocks) {
    if (block.BlockType !== "TABLE") continue;
    const grid: string[][] = [];
    for (const rel of block.Relationships ?? []) {
      if (rel.Type !== "CHILD") continue;
      for (const id of rel.Ids ?? []) {
        const cell = byId.get(id);
        if (cell?.BlockType !== "CELL") continue;
        const row = (cell.RowIndex ?? 1) - 1;
        const col = (cell.ColumnIndex ?? 1) - 1;
        (grid[row] ??= [])[col] = cellText(cell);
      }
    }
    tables.push(grid.map((row) => Array.from(row, (c) => c ?? "")));
  }
  return tables;
}

export const handler: S3Handler = async (event) => {
  const client = await getDataClient();

  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

    // documents/{entityType}/{entityId}/{documentId}/{filename}
    const match = key.match(/^documents\/[^/]+\/[^/]+\/([^/]+)\/(.+)$/);
    if (!match) {
      console.log(`Skipping non-document key: ${key}`);
      continue;
    }
    const [, documentId, filename] = match;
    const ext = filename.split(".").pop()?.toLowerCase() ?? "";

    if (!OCR_EXTENSIONS.has(ext)) {
      await client.models.Document.update({ id: documentId, ocrStatus: "SKIPPED" });
      continue;
    }

    await client.models.Document.update({ id: documentId, ocrStatus: "PROCESSING" });

    try {
      const blocks = await runTextract(bucket, key);

      let text = extractText(blocks);
      if (text.length > MAX_TEXT_CHARS) {
        text = text.slice(0, MAX_TEXT_CHARS) + "\n\n[truncated]";
      }

      let tablesJson: string | undefined = JSON.stringify(extractTables(blocks));
      if (tablesJson.length > MAX_TABLES_CHARS) tablesJson = undefined;

      const { errors } = await client.models.Document.update({
        id: documentId,
        ocrStatus: "COMPLETE",
        ocrText: text,
        ocrTables: tablesJson,
        ocrError: null,
      });
      if (errors?.length) throw new Error(JSON.stringify(errors));
      console.log(`OCR complete for ${documentId} (${key})`);
    } catch (err) {
      console.error(`OCR failed for ${documentId} (${key})`, err);
      await client.models.Document.update({
        id: documentId,
        ocrStatus: "FAILED",
        ocrError: err instanceof Error ? err.message : String(err),
      });
    }
  }
};
