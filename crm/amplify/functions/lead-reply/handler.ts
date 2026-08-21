import { randomBytes } from "node:crypto";
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
import { flattenExtraction } from "./extraction";
import { PORTAL_TTL_DAYS } from "../../../../shared/leadDocuments";
import {
  REPLY_SCHEMA,
  WORD_BUDGET,
  buildPrompt,
  countWords,
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
      const [account, documents, contacts] = await Promise.all([
        client.models.Account.get({ id: reply.accountId }),
        listAllPages((nextToken) =>
          client.models.Document.list({
            filter: { entityId: { eq: reply.accountId } },
            nextToken,
            limit: 200,
          })
        ),
        /**
         * The person's name lives here, not on the Account.
         *
         * `Account.contactFirstName` is superseded by the Contact model and
         * intake never writes it, so reading it produced a null and every
         * single reply opened "Hello," — the loudest possible signal that
         * nobody had read the enquiry.
         */
        listAllPages((nextToken) =>
          client.models.Contact.list({
            filter: { accountId: { eq: reply.accountId } },
            nextToken,
            limit: 50,
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
       * for the next tick to start, so this marks the row before doing either
       * and `decide` refuses anything that is not WAITING.
       *
       * This alone does NOT make a double send impossible, and an earlier
       * version of this comment claimed it did. The update carries no condition
       * on the current status, so two overlapping passes can both read WAITING
       * and both claim. What actually prevents it is a reserved concurrency of
       * one on this function (backend.ts) — the overlap is removed rather than
       * the race being won.
       */
      const claimed = await client.models.LeadReply.update({
        id: reply.id,
        status: "SENDING",
      });
      if (claimed.errors?.length) {
        console.warn("lead-reply could not claim", reply.id, claimed.errors[0].message);
        continue;
      }

      /**
       * Before generating, not after: the prompt is told a link is coming so it
       * stops asking for documents itself, which is most of what keeps the body
       * inside its word budget.
       */
      const uploadUrl = await ensurePortal(client, reply.accountId);

      const lead = toContext(
        account.data,
        documents as { name?: string | null }[],
        contacts as { name?: string | null; isPrimary?: boolean | null }[],
        decision.withDocuments,
        uploadUrl !== null
      );
      const generated = await generate(lead);
      const { subject, text, html } = renderReply({
        generated,
        lead,
        producerName: PRODUCER_NAME,
        uploadUrl,
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
  contacts: { name?: string | null; isPrimary?: boolean | null }[],
  withDocuments: boolean,
  hasUploadLink: boolean
): LeadContext {
  // The primary if one is flagged, otherwise whichever came first — intake
  // creates exactly one, so the fallback is for accounts touched by hand.
  const contact = contacts.find((c) => c.isPrimary) ?? contacts[0];
  const contactName = contact?.name?.trim() || null;
  return {
    name: account.name,
    contactName,
    contactFirstName: contactName ? contactName.split(/\s+/)[0] : null,
    state: account.state ?? null,
    city: account.city ?? null,
    unitCount: account.unitCount ?? null,
    notes: account.notes ?? null,
    source: account.source ?? null,
    documentNames: documents.map((d) => d.name ?? "").filter(Boolean),
    // Only passed when the decision says the documents are usable, so a failed
    // extraction can never leak half-read values into the prose.
    extracted: withDocuments ? flattenExtraction(account.aiExtraction) : null,
    hasUploadLink,
  };
}

/**
 * The lead's document-upload link, minted when their reply goes out.
 *
 * Here rather than at intake because most leads never reach this point — a form
 * with no email address gets no reply and needs no portal — and because the link
 * only exists to be put in this email.
 *
 * Reuses a live portal if the account already has one, so a second reply on the
 * same account does not hand out a second link and split the uploads across two
 * rows. `listUploadPortalByToken` indexes by token, not by account, so the reuse
 * check is a filtered list; there is at most a handful per account.
 *
 * Returns null on any failure, and the caller sends the email without a link.
 * A missing link costs us some documents. A thrown error costs the lead their
 * reply, which is worse.
 */
async function ensurePortal(
  client: DataClient,
  accountId: string
): Promise<string | null> {
  const site = process.env.SITE_BASE_URL;
  if (!site) {
    console.warn("[lead-reply] SITE_BASE_URL unset; sending without an upload link");
    return null;
  }
  try {
    const now = new Date().toISOString();
    const existing = await client.models.UploadPortal.list({
      filter: { accountId: { eq: accountId } },
      limit: 50,
    });
    const live = existing.data?.find((p) => !p.revokedAt && p.expiresAt > now);
    const token =
      live?.token ??
      (await (async () => {
        /**
         * 16 random bytes as base64url: 22 characters, 128 bits.
         *
         * The first version concatenated two UUIDs, which is what
         * `submitWebLead` mints — 68 characters. That token is only ever passed
         * as a mutation argument, so its length costs nothing. This one goes in
         * a URL a person reads in an email, where 68 characters of hex wrapped
         * over three lines was the single most machine-made thing in it.
         *
         * 128 bits is not a reduction in security in any practical sense: it is
         * the same strength as a v4 UUID, guarding a link that expires in sixty
         * days and grants upload-only access to one account.
         */
        const minted = randomBytes(16).toString("base64url");
        const { data, errors } = await client.models.UploadPortal.create({
          accountId,
          token: minted,
          expiresAt: new Date(
            Date.now() + PORTAL_TTL_DAYS * 24 * 60 * 60 * 1000
          ).toISOString(),
          uploadCount: 0,
          updatedBy: "lead-reply",
        });
        if (errors?.length || !data) {
          throw new Error(errors?.[0]?.message ?? "portal create failed");
        }
        return data.token;
      })());

    // The token is a query parameter because a static route cannot read a path
    // segment. `documents.astro` strips it from the URL on load, and that page
    // deliberately mounts no analytics — see the note there.
    return `${site.replace(/\/$/, "")}/documents/?t=${encodeURIComponent(token)}`;
  } catch (err) {
    console.error("[lead-reply] could not mint an upload portal", err);
    return null;
  }
}

/** One model call, forced through the reply schema. */
async function callModel(lead: LeadContext, extraTurns: Anthropic.MessageParam[] = []) {
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
    messages: [{ role: "user", content: buildPrompt(lead) }, ...extraTurns],
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

/**
 * Generate a reply, and hold it to the word budget.
 *
 * A length in a prompt is a suggestion. The instruction said 80 to 140 and the
 * first real lead came back at 153, because a stated range reads as a target to
 * fill rather than a ceiling. So the count is checked here, and over the hard cap
 * the model is asked again with its own draft quoted back at it.
 *
 * One retry, not a loop: the second attempt is nearly always inside the budget,
 * and a lead waiting on an email should not wait on a model arguing with itself.
 * Whichever draft is shorter wins, so the retry can never make things worse.
 * Nothing is truncated — an email cut off at 80 words ends mid-clause, which is
 * a worse failure than a long one.
 */
async function generate(lead: LeadContext) {
  const first = await callModel(lead);
  const words = countWords(first.body);
  if (words <= WORD_BUDGET.HARD) return first;

  console.warn(
    `[lead-reply] body was ${words} words, over the ${WORD_BUDGET.HARD} cap; regenerating`
  );
  try {
    const second = await callModel(lead, [
      { role: "assistant", content: first.body },
      {
        role: "user",
        content:
          `That draft is ${words} words. The ceiling is ${WORD_BUDGET.MAX}. ` +
          `Cut it to under ${WORD_BUDGET.MAX} words. Drop whole sentences rather ` +
          `than trimming words out of every one, and keep the specific detail from ` +
          `their documents over anything general. Do not add a greeting or sign-off.`,
      },
    ]);
    const shorter = countWords(second.body) < words ? second : first;
    console.log(
      `[lead-reply] retry produced ${countWords(second.body)} words; sending ${countWords(shorter.body)}`
    );
    return shorter;
  } catch (err) {
    // A failed retry must not cost the lead their email. The long one is fine.
    console.warn(
      "[lead-reply] length retry failed, sending the first draft",
      err instanceof Error ? err.message : err
    );
    return first;
  }
}
