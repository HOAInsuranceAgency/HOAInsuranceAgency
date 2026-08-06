import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import Anthropic from "@anthropic-ai/sdk";
import type { Schema } from "../../data/resource";
import { CLAUDE_MODEL } from "../model";
import { listAllPages } from "../../../src/lib/pagination";
import {
  CONSTRUCTION_TYPES,
  CONTACT_TYPES,
  DEFAULT_DOCUMENT_CATEGORY,
  DOCUMENT_CATEGORY_EXTRACTION_PRIORITY,
} from "../../../src/lib/enums";

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
  // Every value is a plain string — no nullable/union types. Structured
  // outputs caps union-typed parameters at 16, and per-field
  // value/evidence/source nullability blew past that. "" means "not found";
  // numbers come back as digit strings, booleans as "Yes"/"No" — coerced
  // client-side on apply. valueType is retained only for the description.
  type: "object",
  properties: {
    value: {
      type: "string",
      description:
        Array.isArray(valueType) || valueType === "string"
          ? "The extracted value, or empty string if not found"
          : `The extracted ${valueType} as a plain string (digits only for numbers, "Yes"/"No" for booleans), or empty string if not found`,
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    evidence: {
      type: "string",
      description: "Short verbatim quote (<=150 chars) supporting the value, or empty string",
    },
    source: { type: "string", description: "Filename the value came from, or empty string" },
  },
  required: ["value", "confidence", "evidence", "source"],
  additionalProperties: false,
});

const enumField = (values: string[]) => ({
  type: "object",
  properties: {
    // Single-type string enum with "" allowed — not a union.
    value: { type: "string", enum: [...values, ""] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    evidence: { type: "string" },
    source: { type: "string" },
  },
  required: ["value", "confidence", "evidence", "source"],
  additionalProperties: false,
});

const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    address: field("string"),
    city: field("string"),
    state: {
      ...field("string"),
      description: "Two-letter US state code",
    },
    zip: field("string"),
    unitCount: field("integer"),
    totalInsuredValue: field("number"),
    coastal: field("boolean"),
    milesToCoast: field("number"),
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
    // An array, not four flat columns, because a prior policy packet names
    // the manager, the board president and whoever the inspector called, and
    // the flat shape could carry exactly one of them. Same shape as
    // `buildings` — no per-field confidence, because the reviewer accepts or
    // rejects a whole person rather than their phone number separately.
    contacts: {
      type: "array",
      description:
        "People named in the documents: manager, board officers, accounting, whoever an inspector should call",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Full name, or empty string" },
          email: { type: "string", description: "Email address, or empty string" },
          phone: {
            type: "string",
            description: "Phone as written in the document, or empty string",
          },
          type: { type: "string", enum: [...CONTACT_TYPES, ""] },
        },
        required: ["name", "email", "phone", "type"],
        additionalProperties: false,
      },
    },
    // Construction is per building, not per account. These seven used to be
    // flat fields, which meant an association with a 1978 clubhouse and 2016
    // townhouses got one year built and one construction class for the site.
    buildings: {
      type: "array",
      description:
        "Individual buildings, each with its own construction and square footage",
      items: {
        type: "object",
        properties: {
          label: { type: "string", description: "Building name/label, or empty string" },
          sqft: { type: "string", description: "Square footage as digits only, or empty string" },
          yearBuilt: { type: "string", description: "Year built, or empty string" },
          stories: { type: "string", description: "Storey count, or empty string" },
          constructionType: { type: "string", enum: [...CONSTRUCTION_TYPES, ""] },
          roofYear: { type: "string", description: "Year the roof was last replaced, or empty string" },
          heatingYear: { type: "string", description: "Year heating was last updated, or empty string" },
          wiringYear: { type: "string", description: "Year wiring was last updated, or empty string" },
          plumbingYear: { type: "string", description: "Year plumbing was last updated, or empty string" },
        },
        required: [
          "label",
          "sqft",
          "yearBuilt",
          "stories",
          "constructionType",
          "roofYear",
          "heatingYear",
          "wiringYear",
          "plumbingYear",
        ],
        additionalProperties: false,
      },
    },
    // LOSS_RUNS is already a document category with its own extraction
    // priority, so a loss run reaching this handler is expected. What was
    // missing was anywhere for what it says to go.
    losses: {
      type: "array",
      description:
        "Individual losses from any loss run: one entry per occurrence, not per claim transaction",
      items: {
        type: "object",
        properties: {
          dateOfLoss: { type: "string", description: "ISO date YYYY-MM-DD, or empty string" },
          lineOfBusiness: { type: "string", description: "Line of business, or empty string" },
          typeOfLoss: { type: "string", description: 'Cause, e.g. "Water damage", or empty string' },
          description: { type: "string", description: "What happened, or empty string" },
          claimDate: { type: "string", description: "ISO date the claim was reported, or empty string" },
          amountPaid: { type: "string", description: "Digits only, or empty string" },
          amountReserved: { type: "string", description: "Digits only, or empty string" },
          amountOfLoss: { type: "string", description: "Total incurred, digits only, or empty string" },
          claimOpen: { type: "string", description: '"Yes", "No", or empty string when the run does not say' },
        },
        required: [
          "dateOfLoss",
          "lineOfBusiness",
          "typeOfLoss",
          "description",
          "claimDate",
          "amountPaid",
          "amountReserved",
          "amountOfLoss",
          "claimOpen",
        ],
        additionalProperties: false,
      },
    },
    summary: {
      type: "string",
      description: "2-3 sentence underwriting summary of what the documents show",
    },
  },
  required: [
    "address",
    "city",
    "state",
    "zip",
    "unitCount",
    "totalInsuredValue",
    "coastal",
    "milesToCoast",
    "firewallsVerified",
    "currentCarrier",
    "currentAgent",
    "currentAnnualPremium",
    "currentPolicyExpiration",
    "contacts",
    "buildings",
    "losses",
    "summary",
  ],
  additionalProperties: false,
} as const;

// The lower-case "ISO classes" list inside this prompt is a prose paraphrase,
// not a value list, so it is deliberately NOT generated from
// `CONSTRUCTION_TYPES` — deriving it would reword the prompt. The exact tokens
// the model must return are interpolated into `shapeInstruction` below.
const SYSTEM_PROMPT = `You are a commercial insurance data-extraction assistant for an agency that writes condominium/HOA association master policies. You are given the OCR'd contents of documents attached to a lead (prior policy packets, association budgets, dues schedules, condo documents, loss runs).

Extract every requested datapoint you can find. Rules:
- Every value is a STRING. Use an empty string "" when the documents don't support a value — never guess or infer beyond the text.
- For numeric values return digits only, no "$", commas, or units (e.g. "5000000", "1985", "120"). For yes/no values return "Yes" or "No". Dates as YYYY-MM-DD.
- For each value give a short verbatim evidence quote and the source filename (or "" when the value is empty).
- Confidence: "high" when explicitly stated, "medium" when derived (e.g. summing per-building values), "low" when ambiguous or conflicting across documents.
- totalInsuredValue is the building/property limit (TIV), not liability limits or premium.
- Construction type maps to ISO classes (frame, joisted masonry, non-combustible, masonry non-combustible, modified fire resistive, fire resistive).
- If documents conflict, prefer the most recent/most authoritative (declarations page over marketing text) and note the conflict in the evidence.`;

// Category priority — most data-dense documents first, so caps trim the tail.
// The ranks live beside the category labels in lib/enums.ts so the table
// cannot cover a different set of categories than the schema declares.
const CATEGORY_PRIORITY = DOCUMENT_CATEGORY_EXTRACTION_PRIORITY;
/** Where an uncategorised document sorts — the same rank as OTHER. */
const DEFAULT_PRIORITY = CATEGORY_PRIORITY[DEFAULT_DOCUMENT_CATEGORY];

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
    // DynamoDB applies `filter` AFTER reading a page, so a single list() call
    // returns nothing once the account's documents fall outside the first
    // ~100 scanned rows — which is exactly what happens as the table grows
    // across accounts. Page through until the token is exhausted.
    const docs = await listAllPages((nextToken) =>
      client.models.Document.list({
        filter: { entityId: { eq: accountId }, ocrStatus: { eq: "COMPLETE" } },
        limit: 1000,
        nextToken,
      })
    );

    if (!docs.length) throw new Error("No OCR-complete documents on this account.");

    const sorted = [...docs].sort(
      (a, b) =>
        (CATEGORY_PRIORITY[a.category ?? DEFAULT_DOCUMENT_CATEGORY] ??
          DEFAULT_PRIORITY) -
        (CATEGORY_PRIORITY[b.category ?? DEFAULT_DOCUMENT_CATEGORY] ??
          DEFAULT_PRIORITY)
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

    // Strict structured-output grammar can't compile for a schema this wide
    // ("compiled grammar too large"). Describe the exact JSON shape in the
    // prompt instead and parse defensively.
    const dataKeys = Object.keys(EXTRACTION_SCHEMA.properties).filter(
      (k) =>
        k !== "contacts" &&
        k !== "buildings" &&
        k !== "losses" &&
        k !== "summary"
    );
    const shapeInstruction = `Respond with ONLY a JSON object — no markdown fences, no commentary. The object has exactly these keys:
${dataKeys.join(", ")}
Each of those keys maps to: { "value": <string>, "confidence": "high"|"medium"|"low", "evidence": <string>, "source": <string> }.
Also include:
  "contacts": array of { "name": <string>, "email": <string>, "phone": <string>, "type": <string> } — [] if nobody is named,
  "buildings": array of { "label", "sqft", "yearBuilt", "stories", "constructionType", "roofYear", "heatingYear", "wiringYear", "plumbingYear" } — all strings, "" where the documents don't say, [] if no buildings are documented,
  "losses": array of { "dateOfLoss", "lineOfBusiness", "typeOfLoss", "description", "claimDate", "amountPaid", "amountReserved", "amountOfLoss", "claimOpen" } — all strings, [] if no loss run is attached,
  "summary": <string, 2-3 sentence underwriting summary>.
For a building's "constructionType" use exactly one of: ${CONSTRUCTION_TYPES.join(", ")}, or "". Construction, storeys and the update years are per building — do not repeat one building's answers across the others unless the documents state them for each.
A loss run lists one entry per occurrence. Do not emit a separate entry for each payment or reserve change on the same claim, and leave "claimOpen" empty rather than guessing when the run does not state a status.
For a contact's "type" use exactly one of: ${CONTACT_TYPES.join(", ")}, or "" when the documents don't say what the person's role is. One entry per person — do not repeat the same person under two roles.`;

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: SYSTEM_PROMPT + "\n\n" + shapeInstruction,
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
    // Tolerate stray fences / prose around the JSON object.
    let raw = text.text.trim();
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) raw = fence[1].trim();
    const open = raw.indexOf("{");
    const close = raw.lastIndexOf("}");
    if (open > 0 || close < raw.length - 1) raw = raw.slice(open, close + 1);
    const result = JSON.parse(raw);

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
      // Attributed to the extraction rather than to "system", so the activity
      // log distinguishes a robot's write from an unattributed one.
      lastWriteBy: "extract-lead",
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
      lastWriteBy: "extract-lead",
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
