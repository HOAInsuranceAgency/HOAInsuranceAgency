import { randomBytes } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { db, get, issue } from "../communications/store";
import { enqueueOperation, type Operation } from "../communications/operations";
import { ensureWorkflow } from "../communications/workflow";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import type { Schema } from "../../data/resource";
import { listAllPages } from "../../../src/lib/pagination";
import { CLAUDE_MODEL } from "../model";
import { decide } from "./decide";
import { flattenExtraction } from "./extraction";
import { PORTAL_TTL_DAYS } from "../../../../shared/leadDocuments";
import { propertyNameProblem } from "../../../../shared/propertyName";
import {
  REPLY_SCHEMA,
  WORD_BUDGET,
  buildPrompt,
  capitalizeName,
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

const lambda = new LambdaClient();

/** The real producer these emails come from. Matches the website's wizard. */
const PRODUCER_NAME = "Brian Cole";

/** How many leads one tick will send for. Keeps a backlog from timing out. */
const MAX_PER_TICK = 8;

export const handler = async () => {
  const client = await getDataClient();
  const now = new Date().toISOString();

  // Query the due index; historical SENT rows never join the sweep.
  const result = await client.models.LeadReply.leadRepliesByStatusAndDueAt(
    { status: "WAITING", dueAt: { le: now } }, { limit: MAX_PER_TICK, sortDirection: "ASC" }
  );
  if (result.errors?.length) throw new Error(result.errors[0].message);
  const waiting = result.data;
  // Generating has no external send side effect. Recover a crashed generation
  // only after checking whether its durable send operation already exists.
  const stalled = await client.models.LeadReply.leadRepliesByStatusAndDueAt(
    { status: "SENDING", dueAt: { le: now } }, { limit: MAX_PER_TICK, sortDirection: "ASC" }
  );
  for (const r of stalled.data ?? []) {
    if (Date.parse(r.updatedAt) > Date.now() - 15 * 60_000) continue;
    if (!r.frontGenerationClaimedAt) {
      await client.models.LeadReply.update({ id: r.id, status: "FAILED", note: "Legacy email send could not be confirmed. Review its AWS/Front history before any new reply." });
      await issue(`generation:${r.id}`, "Legacy initial email needs delivery review; it has not been resent", r.accountId); continue;
    }
    const op = await get<Operation>(`op:ai:${r.id}`);
    const status = !op ? "WAITING" : op.data.state === "CONFIRMED" ? "SENT" : op.data.state === "SUPPRESSED" ? "SUPPRESSED" : op.data.state === "FAILED" ? "FAILED" : "QUEUED";
    await db.send(new UpdateCommand({ TableName: process.env.LEAD_REPLY_TABLE, Key: { id: r.id },
      UpdateExpression: "SET #s = :status, updatedAt = :now", ConditionExpression: "#s = :sending",
      ExpressionAttributeNames: { "#s": "status" }, ExpressionAttributeValues: { ":status": status, ":sending": "SENDING", ":now": now },
    })).catch(e => { if (e?.name !== "ConditionalCheckFailedException") throw e; });
    await issue(`generation:${r.id}`, op ? "Recovered queued initial email" : "Initial email generation was interrupted and will retry", r.accountId);
  }

  // Oldest deadline first, so a backlog drains in the order people submitted.
  const due = waiting
    .filter((r) => r.dueAt <= now)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));

  const summary = { waiting: waiting.length, due: due.length, queued: 0, extracting: 0, failed: 0 };

  for (const reply of due.slice(0, MAX_PER_TICK)) {
    let queued = false;
    try {
      if (!reply.submissionId) {
        await client.models.LeadReply.update({ id: reply.id, status: "FAILED", note: "Legacy pending reply held for migration review; no Front resend was attempted." });
        await issue(`generation:${reply.id}`, "Review the legacy initial reply and existing Front conversation before contacting this lead", reply.accountId); continue;
      }
      const priorOperation = await get<Operation>(`op:ai:${reply.id}`);
      if (priorOperation) {
        await client.models.LeadReply.update({ id: reply.id, status: priorOperation.data.state === "CONFIRMED" ? "SENT" : priorOperation.data.state === "SUPPRESSED" ? "SUPPRESSED" : priorOperation.data.state === "FAILED" ? "FAILED" : "QUEUED" });
        continue;
      }
      const workflow = await ensureWorkflow(reply.accountId);
      if (workflow.data.humanTakeover || workflow.data.disposition !== "ACTIVE") {
        await client.models.LeadReply.update({ id: reply.id, status: "SUPPRESSED", note: "The team is handling this lead." });
        continue;
      }

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

      if (account.errors?.length) throw new Error("The lead could not be read; generation needs retry");
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

      await db.send(new UpdateCommand({
        TableName: process.env.LEAD_REPLY_TABLE, Key: { id: reply.id },
        UpdateExpression: "SET #s = :sending, updatedAt = :now, frontGenerationClaimedAt = :now",
        ConditionExpression: "#s = :waiting",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":sending": "SENDING", ":waiting": "WAITING", ":now": now },
      }));

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
      if (lead.nameProblem) {
        console.warn(
          `[lead-reply] association name looks off: "${account.data.name}" (${lead.nameProblem})`
        );
      }
      const generated = await generate(lead);
      const { subject, text, html } = renderReply({
        generated,
        lead,
        producerName: PRODUCER_NAME,
        uploadUrl,
      });

      await enqueueOperation(`op:ai:${reply.id}`, {
        type: "EMAIL", accountId: reply.accountId, replyId: reply.id,
        recipient: reply.contactEmail, subject, text, html,
      });
      queued = true;

      /**
       * The producer-facing trail: a reply that never names the association
       * looks like a bug unless the row says the name was unusable — and the
       * note is also what prompts someone to ask the lead what the
       * association is actually called.
       */
      const nameNote = lead.nameProblem
        ? `The association name "${account.data.name}" looks incomplete or not real (${lead.nameProblem}); the reply avoided using it.`
        : null;
      // The delivery worker may already have confirmed SENT. Never overwrite
      // that result with this producer's delayed QUEUED projection.
      await db.send(new UpdateCommand({ TableName: process.env.LEAD_REPLY_TABLE, Key: { id: reply.id },
        UpdateExpression: "SET #s = :queued, sentSubject = :subject, sentBody = :body, note = :note, updatedAt = :now",
        ConditionExpression: "#s = :sending", ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":queued": "QUEUED", ":sending": "SENDING", ":subject": subject, ":body": text, ":note": [decision.note, nameNote].filter(Boolean).join(" ") || null, ":now": new Date().toISOString() },
      })).catch(e => { if (e?.name !== "ConditionalCheckFailedException") throw e; });
      summary.queued++;
      console.log("lead-reply queued", reply.id, JSON.stringify({ subject }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A reporting failure after capture cannot turn a pending send into a
      // claim of non-delivery. If storage is unavailable, keep SENDING so the
      // existing recovery pass can reconcile it after storage returns.
      let operation: Awaited<ReturnType<typeof get<Operation>>>;
      try { operation = await get<Operation>(`op:ai:${reply.id}`); }
      catch { await issue(`generation:${reply.id}`, "Could not verify initial email delivery. Check the delivery queue before contacting the prospect.", reply.accountId).catch(() => {}); continue; }
      if (queued || operation) {
        summary.queued++;
        await issue(`generation:${reply.id}`, "Initial email is in the delivery queue; its status display needs reconciliation. Do not send another initial reply.", reply.accountId);
        continue;
      }
      summary.failed++;
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
      await issue(`generation:${reply.id}`, `Initial email generation failed: ${message}`.slice(0, 500), reply.accountId);
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
  const rawContactName = contact?.name?.trim() || null;
  /**
   * Intake reuses the association name as the Contact's `name` when the form
   * gave an email but no person (`name: contactName ?? name` there). Greeting
   * that person "Hi Maple," out of "Maple Ridge Condominium" is worse than
   * the plain "Hello,", so a contact whose name is the account's own is
   * treated as having none.
   */
  const personName =
    rawContactName &&
    rawContactName.toLowerCase() !== account.name.trim().toLowerCase()
      ? rawContactName
      : null;
  // Typed-without-shift names get their capitals back before the model or the
  // greeting ever sees them: "jake greasley" reads as "Jake Greasley" in both.
  const contactName = capitalizeName(personName);
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
    // "test", "my hoa", keyboard mash: when set, the prompt tells the model to
    // write around the name rather than put it in a subject line.
    nameProblem: propertyNameProblem(account.name),
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
