import { createHash } from "node:crypto";
import {
  TextractClient,
  StartDocumentAnalysisCommand,
  GetDocumentAnalysisCommand,
  type Block,
} from "@aws-sdk/client-textract";
import type { StatementIntake } from "../../../../shared/commissionIntake";
import { required } from "../../../../shared/commissions";
import * as store from "./store";
const textract = new TextractClient();
/** OCR output remains untrusted source data. No matches, eligibility or receipts are approved here. */
export function statementTables(blocks: Block[]) {
  const byId = new Map(blocks.filter((b) => b.Id).map((b) => [b.Id!, b]));
  const childText = (block: Block) =>
    (block.Relationships ?? [])
      .filter((r) => r.Type === "CHILD")
      .flatMap((r) => r.Ids ?? [])
      .map((id) => byId.get(id)?.Text ?? "")
      .filter(Boolean)
      .join(" ");
  const tables = blocks
    .filter((b) => b.BlockType === "TABLE")
    .map((table, index) => {
      const cells = (table.Relationships ?? [])
        .filter((r) => r.Type === "CHILD")
        .flatMap((r) => r.Ids ?? [])
        .map((id) => byId.get(id))
        .filter((b): b is Block => b?.BlockType === "CELL");
      const rows: string[][] = [];
      for (const cell of cells) {
        const r = (cell.RowIndex ?? 1) - 1,
          c = (cell.ColumnIndex ?? 1) - 1;
        if (r > 1000 || c > 63)
          throw new Error(
            "The extracted table exceeds the import limit. Review the original statement.",
          );
        rows[r] ??= [];
        rows[r][c] = childText(cell);
      }
      const width = Math.max(0, ...rows.map((r) => r.length));
      return {
        name: "Page " + (table.Page ?? 1) + " · table " + (index + 1),
        rows: Array.from({ length: rows.length }, (_, i) =>
          Array.from({ length: width }, (_, j) => rows[i]?.[j] ?? ""),
        ),
        confidence: Math.min(100, ...cells.map((c) => c.Confidence ?? 0)),
      };
    })
    .filter((t) => t.rows.length > 1);
  const text = blocks
    .filter((b) => b.BlockType === "LINE")
    .map((b) => b.Text ?? "")
    .join("\n");
  const result = { tables, text };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 800_000)
    throw new Error(
      "Extraction is too large for one review. Use the carrier spreadsheet or enter source rows manually.",
    );
  return result;
}
export async function extractIntakeDocument(
  intake: StatementIntake,
  actor: string,
  input: store.Data,
) {
  if (!/\.(pdf|png|jpe?g|tiff?)$/i.test(intake.filename))
    throw new Error(
      "Use PDF or an image for extraction; import spreadsheets directly.",
    );
  if (!intake.extractionJobId || input.restart === true) {
    if (input.version !== intake.version)
      throw new Error("The statement changed. Refresh before extracting.");
    const requestId = input.restart
      ? required(input.requestId, "an extraction request ID", 128)
      : "initial";
    const job = await textract.send(
      new StartDocumentAnalysisCommand({
        DocumentLocation: {
          S3Object: {
            Bucket: process.env.COMMISSION_BUCKET,
            Name: intake.source,
          },
        },
        FeatureTypes: ["TABLES"],
        ClientRequestToken: createHash("sha256")
          .update(intake.id + "|" + intake.fileHash + "|" + requestId)
          .digest("hex"),
      }),
    );
    if (!job.JobId) throw new Error("Document extraction did not start.");
    await store.commit(
      [
        {
          kind: "STATEMENT_INTAKE",
          value: { ...intake, extractionJobId: job.JobId },
          previous: intake as unknown as store.Data,
        },
      ],
      actor,
    );
    return { ok: true, status: "PROCESSING" };
  }
  let next: string | undefined;
  const blocks: Block[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < 50; page++) {
    const result = await textract.send(
      new GetDocumentAnalysisCommand({
        JobId: intake.extractionJobId,
        ...(next ? { NextToken: next } : {}),
      }),
    );
    if (result.JobStatus === "IN_PROGRESS")
      return { ok: true, status: "PROCESSING" };
    if (result.JobStatus !== "SUCCEEDED")
      throw new Error(
        "Extraction did not complete all pages. Retry extraction or enter the statement manually; partial results were not imported.",
      );
    blocks.push(...(result.Blocks ?? []));
    if (!result.NextToken)
      return { ok: true, status: "READY", ...statementTables(blocks) };
    if (seen.has(result.NextToken))
      throw new Error(
        "Extraction pagination did not complete. No rows were imported.",
      );
    next = result.NextToken;
    seen.add(next);
  }
  throw new Error(
    "Extraction exceeds the review limit. No partial rows were imported. Use the carrier spreadsheet.",
  );
}
