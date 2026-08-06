import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import Anthropic from "@anthropic-ai/sdk";
import type { Schema } from "../../data/resource";
import { CLAUDE_MODEL } from "../model";
import { listAllPages } from "../../../src/lib/pagination";
import { MAX_FIELDS, sanitiseSuggestions, type Suggestion } from "./sanitise";

/**
 * AI gap-filling for a carrier-submission PDF.
 *
 * The client fills the template deterministically first and never asks about
 * a field it already answered — this handler only ever sees the blanks. It
 * assembles everything the CRM knows about the account, asks Claude which of
 * the named fields the data actually supports, and returns the survivors of
 * `sanitiseSuggestions`.
 *
 * What it does NOT do is write a PDF. The browser holds the document; this
 * returns values and the one-line reason for each, and the producer sees both
 * in the generation panel before the file is stored. That is the whole safety
 * story for the feature: nothing reaches a carrier unread.
 */

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

/** Columns present on every row and interesting on none of them. */
const DROP_KEYS = new Set([
  "createdAt",
  "updatedAt",
  "owner",
  "lastWriteBy",
  "__typename",
  "extractionSourceKey",
  // The raw extraction blob: the reviewed values are already on the account
  // and the unreviewed ones are exactly what must not reach a carrier form.
  "aiExtraction",
]);

type Row = Record<string, unknown>;

/** A record as the prompt sees it: no nulls, no plumbing, no empty objects. */
function slim(row: Row): Row | null {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (DROP_KEYS.has(k)) continue;
    if (v == null || v === "") continue;
    if (typeof v === "function") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

function slimAll(rows: Row[]): Row[] {
  return rows.map(slim).filter((r): r is Row => r !== null);
}

/**
 * Everything the CRM knows about one account, as JSON.
 *
 * Whole rows minus the plumbing rather than a hand-picked column list: a
 * mapping added to the schema next month should reach the model without
 * anybody remembering to widen this function.
 */
async function accountBundle(
  client: ReturnType<typeof generateClient<Schema>>,
  accountId: string
) {
  const byAccount = <T>(
    list: (args: {
      filter: { accountId: { eq: string } };
      nextToken?: string;
    }) => Promise<{ data: T[]; nextToken?: string | null }>
  ) =>
    listAllPages<T>((nextToken) =>
      list({ filter: { accountId: { eq: accountId } }, nextToken })
    );

  const { data: account } = await client.models.Account.get({ id: accountId });
  if (!account) throw new Error("Account not found.");

  const [
    contacts,
    priorCarriers,
    buildings,
    blankets,
    glApplications,
    glClassCodes,
    doApplications,
    doCoverageParts,
    losses,
    quotes,
    policies,
  ] = await Promise.all([
    byAccount(client.models.Contact.list),
    byAccount(client.models.PriorCarrier.list),
    byAccount(client.models.Building.list),
    byAccount(client.models.Blanket.list),
    byAccount(client.models.GlApplication.list),
    byAccount(client.models.GlClassCode.list),
    byAccount(client.models.DoApplication.list),
    byAccount(client.models.DoCoveragePart.list),
    byAccount(client.models.Loss.list),
    byAccount(client.models.Quote.list),
    byAccount(client.models.Policy.list),
  ]);

  return {
    account: slim(account as Row),
    contacts: slimAll(contacts as Row[]),
    priorCarriers: slimAll(priorCarriers as Row[]),
    buildings: slimAll(buildings as Row[]),
    blankets: slimAll(blankets as Row[]),
    glApplication: slimAll(glApplications as Row[])[0] ?? null,
    glClassCodes: slimAll(glClassCodes as Row[]),
    doApplication: slimAll(doApplications as Row[])[0] ?? null,
    doCoverageParts: slimAll(doCoverageParts as Row[]),
    losses: slimAll(losses as Row[]),
    // Dead quotes and expired policies describe an account the underwriter is
    // not being asked about.
    quotes: slimAll(
      (quotes as Row[]).filter((q) => q.status !== "LOST" && q.status !== "DECLINED")
    ),
    policies: slimAll((policies as Row[]).filter((p) => p.status === "ACTIVE")),
  };
}

const SYSTEM_PROMPT = `You are completing an ACORD form for a commercial insurance agency that writes condominium/HOA association master policies. You are given everything the agency's CRM knows about one account, plus the names of form fields that are still blank after the CRM filled in everything it maps directly.

Your job is to answer ONLY the fields the account data actually supports.

Rules:
- Every value is a string. Return "" for any field the data does not answer — that is the expected outcome for most fields, and it is a correct answer, not a failure.
- Do not infer, estimate, round, or calculate a value the data does not state, unless the calculation is a plain sum or count of values that ARE stated (say so in "why" when it is).
- Never abbreviate or reformat a legal entity name. Write it exactly as the account records it.
- Dates go in US format: MM/DD/YYYY.
- Money goes in as digits with no currency symbol and no cents unless the data has cents.
- Return only the field names you were given. A field name you were not asked about is discarded.
- Do NOT write "pending", "pending info", "TBD", "to be determined", "N/A", "unknown", "none provided", "see attached", "refer to", "various", "?" or a dash. If you do not have the value, the value is "". A placeholder on a form that goes to a carrier is a statement the agency did not make; a blank is not.
- "why" is one short line naming where in the account data the value came from (e.g. "Building 2 roofYear"). It is shown to the producer next to the value before the form is sent, so it must be checkable.

Respond with ONLY a JSON object — no markdown fences, no commentary:
{"fields":[{"field":"<exact field name>","value":"<string>","why":"<one line>"}]}
Omit fields you would answer with "". If you can answer none of them, return {"fields":[]}.`;

async function suggest(
  accountId: string,
  formKey: string,
  fieldNames: string[]
): Promise<{ values: Suggestion[]; skipped: number; usage: unknown }> {
  const client = await getDataClient();
  const bundle = await accountBundle(client, accountId);

  const asked = fieldNames.slice(0, MAX_FIELDS);
  const skipped = fieldNames.length - asked.length;

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 12000,
    thinking: { type: "adaptive" },
    // Deliberately below the default. This call runs inside AppSync's 30s
    // resolver limit with a producer watching a spinner, and the work is
    // reading structured data rather than reasoning about it — the failure
    // mode this feature has to avoid is inventing values, and that is what
    // the prompt and the sanitiser are for, not thinking depth.
    output_config: { effort: "medium" },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `ACCOUNT DATA (JSON):\n${JSON.stringify(bundle, null, 1)}`,
            // Generating a 125, a 126 and four 140s for one account is six
            // calls over this exact block. Cache it and only the field list
            // below is new each time.
            cache_control: { type: "ephemeral" },
          },
          {
            type: "text",
            text: `Form: ${formKey}\nBlank field names (${asked.length}):\n${asked.join("\n")}`,
          },
        ],
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("The model declined to complete this form.");
  }
  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("No suggestions returned.");

  // Same defensive parse as extract-lead: tolerate a fence or stray prose.
  let raw = text.text.trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) raw = fence[1].trim();
  const open = raw.indexOf("{");
  const close = raw.lastIndexOf("}");
  if (open > 0 || close < raw.length - 1) raw = raw.slice(open, close + 1);

  return {
    values: sanitiseSuggestions(JSON.parse(raw), asked),
    skipped,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens,
    },
  };
}

export const handler: Schema["suggestFormFields"]["functionHandler"] = async (
  event
) => {
  const { accountId, formKey, fieldNames } = event.arguments;
  const names = (fieldNames ?? []).filter(
    (n): n is string => typeof n === "string" && n.length > 0
  );
  if (!names.length) return { ok: true, values: [], skipped: 0 };

  try {
    const { values, skipped, usage } = await suggest(accountId, formKey, names);
    console.log(
      `Form fill for ${accountId} (${formKey}): asked ${names.length - skipped}, ` +
        `returned ${values.length}`,
      JSON.stringify(usage)
    );
    return { ok: true, values, skipped };
  } catch (err) {
    // Never fatal to the generation. The deterministic PDF is already correct
    // and complete as far as the mapping goes; losing the gap-fill costs the
    // producer some typing, and the panel says so rather than failing the
    // whole document over an AI outage.
    console.error(`Form fill failed for ${accountId} (${formKey})`, err);
    return {
      ok: false,
      values: [],
      skipped: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};
