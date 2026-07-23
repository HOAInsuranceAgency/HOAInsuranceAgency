import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import Anthropic from "@anthropic-ai/sdk";
import type { Schema } from "../../data/resource";

/**
 * Two invocation modes:
 *  1. AppSync resolver (startLeadExtraction mutation): marks the account
 *     PENDING, re-invokes itself asynchronously with a work payload, and
 *     returns immediately (AppSync caps resolvers at 30s).
 *  2. Worker (async self-invoke): gathers OCR text/tables from the account's
 *     documents, calls Claude with a strict JSON schema, and writes the
 *     extraction result back onto the account.
 */

const lambda = new LambdaClient();

let dataClient: ReturnType<typeof generateClient<Schema>> | undefined;
async function getDataClient() {
  if (!dataClient) {
    const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(
      process.env as never
    );
    Amplify.configure(resourceConfig, libraryOptions);
    dataClient = generateClient<Schema>();
  }
  return dataClient;
}

// ── Extraction schema (structured outputs — additionalProperties:false,
//    every property required, nullable via type arrays) ─────────────────

const field = (valueType: string | string[]) => ({
  type: "object",
  properties: {
    value: { type: Array.isArray(valueType) ? valueType : [valueType, "null"] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    evidence: {
      type: ["string", "null"],
      description: "Short verbatim quote (<=150 chars) supporting the value",
    },
    source: { type: ["string", "null"], description: "Filename the value came from" },
  },
  required: ["value", "confidence", "evidence", "source"],
  additionalProperties: false,
});

const enumField = (values: string[]) => ({
  type: "object",
  properties: {
    value: { type: ["string", "null"], enum: [...values, null] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    evidence: { type: ["string", "null"] },
    source: { type: ["string", "null"] },
  },
  required: ["value", "confidence", "evidence", "source"],
  additionalProperties: false,
});

const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    contactFirstName: field("string"),
    contactLastName: field("string"),
    contactEmail: field("string"),
    contactPhone: field("string"),
    address: field("string"),
    city: field("string"),
    state: {
      ...field("string"),
      description: "Two-letter US state code",
    },
    zip: field("string"),
    unitCount: field("integer"),
    yearBuilt: field("integer"),
    totalInsuredValue: field("number"),
    constructionType: enumField([
      "FRAME",
      "JOISTED_MASONRY",
      "NON_COMBUSTIBLE",
      "MASONRY_NON_COMBUSTIBLE",
      "MODIFIED_FIRE_RESISTIVE",
      "FIRE_RESISTIVE",
    ]),
    stories: field("integer"),
    coastal: field("boolean"),
    milesToCoast: field("number"),
    roofUpdatedYear: field("integer"),
    hvacUpdatedYear: field("integer"),
    electricalUpdatedYear: field("integer"),
    plumbingUpdatedYear: field("integer"),
    firewallsVerified: field("boolean"),
    currentCarrier: field("string"),
    currentAgent: {
      ...field("string"),
      description: "Incumbent agent/broker/agency servicing the account (not the carrier)",
    },
    currentAnnualPremium: field("number"),
    currentPolicyExpiration: {
      ...field("string"),
      description: "ISO date YYYY-MM-DD of current policy expiration",
    },
    buildings: {
      type: "array",
      description: "Individual buildings with square footage, if documented",
      items: {
        type: "object",
        properties: {
          label: { type: ["string", "null"] },
          sqft: { type: ["integer", "null"] },
        },
        required: ["label", "sqft"],
        additionalProperties: false,
      },
    },
    summary: {
      type: "string",
      description: "2-3 sentence underwriting summary of what the documents show",
    },
  },
  required: [
    "contactFirstName",
    "contactLastName",
    "contactEmail",
    "contactPhone",
    "address",
    "city",
    "state",
    "zip",
    "unitCount",
    "yearBuilt",
    "totalInsuredValue",
    "constructionType",
    "stories",
    "coastal",
    "milesToCoast",
    "roofUpdatedYear",
    "hvacUpdatedYear",
    "electricalUpdatedYear",
    "plumbingUpdatedYear",
    "firewallsVerified",
    "currentCarrier",
    "currentAgent",
    "currentAnnualPremium",
    "currentPolicyExpiration",
    "buildings",
    "summary",
  ],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You are a commercial insurance data-extraction assistant for an agency that writes condominium/HOA association master policies. You are given the OCR'd contents of documents attached to a lead (prior policy packets, association budgets, dues schedules, condo documents, loss runs).

Extract every requested datapoint you can find. Rules:
- Only report a value when the documents actually support it — use null otherwise. Never guess or infer beyond the text.
- For each value give a short verbatim evidence quote and the source filename.
- Confidence: "high" when explicitly stated, "medium" when derived (e.g. summing per-building values), "low" when ambiguous or conflicting across documents.
- totalInsuredValue is the building/property limit (TIV), not liability limits or premium.
- Construction type maps to ISO classes (frame, joisted masonry, non-combustible, masonry non-combustible, modified fire resistive, fire resistive).
- If documents conflict, prefer the most recent/most authoritative (declarations page over marketing text) and note the conflict in the evidence.`;

// Category priority — most data-dense documents first, so caps trim the tail.
const CATEGORY_PRIORITY: Record<string, number> = {
  PRIOR_POLICY: 0,
  BUDGET: 1,
  DUES_SCHEDULE: 2,
  LOSS_RUNS: 3,
  OTHER: 4,
  QUOTE_DOC: 5,
  POLICY_DOC: 6,
  CONDO_DOCS: 7, // huge and low-density — last
  ACORD_FORM: 8,
  LICENSE: 9,
};

const TOTAL_CHAR_BUDGET = 400_000; // ~100K tokens of document text

function renderTables(raw: unknown): string {
  let v: unknown = raw;
  try {
    if (typeof v === "string") v = JSON.parse(v);
    if (typeof v === "string") v = JSON.parse(v);
  } catch {
    return "";
  }
  if (!Array.isArray(v)) return "";
  return (v as string[][][])
    .map((table, i) => `\n[Table ${i + 1}]\n` + table.map((row) => row.join("\t")).join("\n"))
    .join("\n");
}

async function runExtraction(accountId: string) {
  const client = await getDataClient();

  try {
    const { data: docs } = await client.models.Document.list({
      filter: { entityId: { eq: accountId }, ocrStatus: { eq: "COMPLETE" } },
    });
    if (!docs.length) throw new Error("No OCR-complete documents on this account.");

    const sorted = [...docs].sort(
      (a, b) =>
        (CATEGORY_PRIORITY[a.category ?? "OTHER"] ?? 4) -
        (CATEGORY_PRIORITY[b.category ?? "OTHER"] ?? 4)
    );

    let budget = TOTAL_CHAR_BUDGET;
    const parts: string[] = [];
    let included = 0;
    for (const doc of sorted) {
      if (budget <= 5_000) break;
      const body = `${doc.ocrText ?? ""}${renderTables(doc.ocrTables)}`;
      const slice = body.slice(0, budget);
      parts.push(
        `===== DOCUMENT: ${doc.name} (category: ${doc.category ?? "OTHER"}) =====\n${slice}${
          slice.length < body.length ? "\n[document truncated]" : ""
        }`
      );
      budget -= slice.length;
      included++;
    }

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: SYSTEM_PROMPT,
      output_config: {
        format: { type: "json_schema", schema: EXTRACTION_SCHEMA as never },
      },
      messages: [
        {
          role: "user",
          content: `Extract the lead datapoints from these ${included} document(s):\n\n${parts.join(
            "\n\n"
          )}`,
        },
      ],
    });

    if (response.stop_reason === "refusal") {
      throw new Error("Extraction was declined by the model.");
    }
    const text = response.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") throw new Error("No extraction output returned.");
    const result = JSON.parse(text.text);

    const { errors } = await client.models.Account.update({
      id: accountId,
      extractionStatus: "COMPLETE",
      aiExtraction: JSON.stringify({
        ...result,
        extractedAt: new Date().toISOString(),
        documentCount: included,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      }),
      extractionError: null,
    });
    if (errors?.length) throw new Error(errors[0].message);
    console.log(
      `Extraction complete for ${accountId}: ${included} docs, ` +
        `${response.usage.input_tokens} in / ${response.usage.output_tokens} out tokens`
    );
  } catch (err) {
    console.error(`Extraction failed for ${accountId}`, err);
    await client.models.Account.update({
      id: accountId,
      extractionStatus: "FAILED",
      extractionError: err instanceof Error ? err.message : String(err),
    });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handler = async (event: any) => {
  // Worker branch (async self-invoke)
  if (event?.work?.accountId) {
    await runExtraction(event.work.accountId);
    return { ok: true };
  }

  // Resolver branch (AppSync mutation)
  const accountId: string | undefined = event?.arguments?.accountId;
  if (!accountId) return { ok: false, error: "accountId is required" };

  const client = await getDataClient();
  await client.models.Account.update({
    id: accountId,
    extractionStatus: "PENDING",
    extractionError: null,
  });

  await lambda.send(
    new InvokeCommand({
      FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify({ work: { accountId } })),
    })
  );

  return { ok: true, started: true };
};
