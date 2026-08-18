import Anthropic from "@anthropic-ai/sdk";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import type { Schema } from "../../data/resource";
import { listAllPages } from "../../../src/lib/pagination";
import { AGENCY, AGENCY_FMT } from "../../../../shared/agency";
import { CLAUDE_MODEL } from "../model";
import { decide } from "./decide";
import {
  REPLY_SCHEMA,
  buildPrompt,
  renderReply,
  systemPrompt,
  type LeadContext,
} from "./email";

/**
 * Website lead auto-reply sweep. See resource.ts for the why.
 *
 * Per tick: find windows whose deadline has passed → for each, decide → send,
 * kick extraction off, or leave it for the next tick.
 */

type DataClient = ReturnType<typeof generateClient<Schema>>;
let dataClient: DataClient | undefined;
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

const ses = new SESv2Client();
const lambda = new LambdaClient();

/** The real producer these emails come from. Matches the website's wizard. */
const PRODUCER_NAME = "Brian Cole";

/**
 * The agency-side mailbox: From, Reply-To and the team's BCC all use it.
 *
 * Set per branch in `backend.ts` — sales@ on main, a plus-addressed test box
 * everywhere else — so staging can send real mail without putting a test
 * conversation in front of the team or routing a reply into their queue. The
 * fallback is the agency's sales address only if the variable is missing
 * entirely, which should not happen once deployed.
 */
const MAILBOX = process.env.AGENCY_MAILBOX || AGENCY_FMT.leadEmailLower;

/** Named sender, so it reads as a person rather than a system. */
const FROM = `${PRODUCER_NAME} · ${AGENCY.name} <${MAILBOX}>`;

/**
 * The team's own copy.
 *
 * SES sends straight to the lead, so a From of the mailbox puts nothing in it:
 * there is no submission through it and no Sent folder. Without this BCC the
 * agency would have no idea what any lead had been told. BCC rather than CC so
 * the lead does not see an internal address on their own email.
 */
const BCC = [MAILBOX];

/** How many leads one tick will send for. Keeps a backlog from timing out. */
const MAX_PER_TICK = 8;

export const handler = async () => {
  const client = await getDataClient();
  const now = new Date().toISOString();

  const waiting = (await listAllPages((nextToken) =>
    client.models.LeadReply.list({
      filter: { status: { eq: "WAITING" } },
      nextToken,
      limit: 200,
    })
  )) as Schema["LeadReply"]["type"][];

  // Oldest deadline first, so a backlog drains in the order people submitted.
  const due = waiting
    .filter((r) => r.dueAt <= now)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));

  const summary = { waiting: waiting.length, due: due.length, sent: 0, extracting: 0, failed: 0 };

  for (const reply of due.slice(0, MAX_PER_TICK)) {
    try {
      const [account, documents] = await Promise.all([
        client.models.Account.get({ id: reply.accountId }),
        listAllPages((nextToken) =>
          client.models.Document.list({
            filter: { entityId: { eq: reply.accountId } },
            nextToken,
            limit: 200,
          })
        ),
      ]);

      if (!account.data) {
        // The lead was deleted under us. Nothing to reply about.
        await client.models.LeadReply.update({
          id: reply.id,
          status: "FAILED",
          note: "The lead no longer exists.",
        });
        summary.failed++;
        continue;
      }

      const decision = decide({
        reply,
        documents: documents as { name?: string | null; ocrStatus?: string | null }[],
        account: account.data,
        now,
      });

      if (decision.action === "wait") {
        console.log("lead-reply waiting", reply.id, decision.reason);
        continue;
      }

      if (decision.action === "extract") {
        /**
         * Kick extraction off on the lead's behalf.
         *
         * `startLeadExtraction` is `allow.authenticated()`, so a website visitor
         * can never reach it — this is the only path that runs extraction for a
         * public lead. Invoked in the mutation's own event shape rather than the
         * worker's, so the PENDING marking and the self-invoke stay in one place
         * instead of being half-reimplemented here.
         */
        await lambda.send(
          new InvokeCommand({
            FunctionName: process.env.EXTRACT_LEAD_FUNCTION,
            InvocationType: "Event",
            Payload: Buffer.from(
              JSON.stringify({ arguments: { accountId: reply.accountId } })
            ),
          })
        );
        summary.extracting++;
        console.log("lead-reply extraction started", reply.id);
        continue;
      }

      /**
       * Claim it before generating.
       *
       * Sending takes a model call plus an SES round trip, which is long enough
       * for the next tick to start. Flipping to SENDING first is what stops two
       * sweeps emailing the same person twice — `decide` refuses anything that
       * is not WAITING.
       */
      const claimed = await client.models.LeadReply.update({
        id: reply.id,
        status: "SENDING",
      });
      if (claimed.errors?.length) {
        console.warn("lead-reply could not claim", reply.id, claimed.errors[0].message);
        continue;
      }

      const lead = toContext(
        account.data,
        documents as { name?: string | null }[],
        decision.withDocuments
      );
      const generated = await generate(lead);
      const { subject, text, html } = renderReply({
        generated,
        lead,
        producerName: PRODUCER_NAME,
      });

      await ses.send(
        new SendEmailCommand({
          FromEmailAddress: FROM,
          ReplyToAddresses: [MAILBOX],
          Destination: { ToAddresses: [reply.contactEmail], BccAddresses: BCC },
          Content: {
            Simple: {
              Subject: { Data: subject, Charset: "UTF-8" },
              Body: {
                Text: { Data: text, Charset: "UTF-8" },
                Html: { Data: html, Charset: "UTF-8" },
              },
            },
          },
        })
      );

      await client.models.LeadReply.update({
        id: reply.id,
        status: "SENT",
        sentAt: new Date().toISOString(),
        // Stored as sent, after the dash-stripping in renderReply, so the
        // record matches the email rather than the model's raw output.
        sentSubject: subject,
        sentBody: text,
        note: decision.note ?? null,
      });
      summary.sent++;
      console.log("lead-reply sent", reply.id, JSON.stringify({ subject }));
    } catch (err) {
      summary.failed++;
      const message = err instanceof Error ? err.message : String(err);
      /**
       * FAILED, not back to WAITING.
       *
       * A retry loop on a permanent error — a rejected recipient, a model that
       * refuses — would re-run the model every minute forever. A producer can
       * see the row and the reason on the account, and reply by hand.
       */
      await client.models.LeadReply.update({
        id: reply.id,
        status: "FAILED",
        note: `Auto-reply failed: ${message}`.slice(0, 500),
      }).catch(() => {});
      console.error("lead-reply failed", reply.id, message);
    }
  }

  console.log("lead-reply sweep", JSON.stringify(summary));
  return summary;
};

/** Narrow an Account plus its documents down to what the prompt may see. */
function toContext(
  account: Schema["Account"]["type"],
  documents: { name?: string | null }[],
  withDocuments: boolean
): LeadContext {
  return {
    name: account.name,
    contactName: account.contactFirstName
      ? [account.contactFirstName, account.contactLastName].filter(Boolean).join(" ")
      : null,
    contactFirstName: account.contactFirstName ?? null,
    state: account.state ?? null,
    city: account.city ?? null,
    unitCount: account.unitCount ?? null,
    notes: account.notes ?? null,
    source: account.source ?? null,
    documentNames: documents.map((d) => d.name ?? "").filter(Boolean),
    // Only passed when the decision says the documents are usable, so a failed
    // extraction can never leak half-read values into the prose.
    extracted: withDocuments ? flattenExtraction(account.aiExtraction) : null,
  };
}

/**
 * `aiExtraction` is `{ field: { value, confidence, evidence } }`. The prompt
 * gets values only — a model shown a confidence score starts hedging in prose,
 * and evidence strings are long enough to crowd out the instructions.
 */
function flattenExtraction(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== "object") return null;
  const out: Record<string, string> = {};
  for (const [key, cell] of Object.entries(raw as Record<string, unknown>)) {
    const value =
      cell && typeof cell === "object" && "value" in cell
        ? (cell as { value?: unknown }).value
        : cell;
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
    else if (typeof value === "number") out[key] = String(value);
  }
  return Object.keys(out).length ? out : null;
}

/** One model call, forced through the reply schema. */
async function generate(lead: LeadContext) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2000,
    system: systemPrompt(PRODUCER_NAME),
    tools: [
      {
        name: "write_reply",
        description: "Return the reply to send to this lead.",
        input_schema: REPLY_SCHEMA as never,
      },
    ],
    tool_choice: { type: "tool", name: "write_reply" },
    messages: [{ role: "user", content: buildPrompt(lead) }],
  });

  const block = response.content.find((c) => c.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error("The model returned no reply.");
  }
  const out = block.input as { subject?: string; body?: string };
  if (!out.subject?.trim() || !out.body?.trim()) {
    throw new Error("The model returned an empty reply.");
  }
  return { subject: out.subject.trim(), body: out.body.trim() };
}
