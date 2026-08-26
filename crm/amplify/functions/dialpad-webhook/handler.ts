import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import type { Schema } from "../../data/resource";
import { listAllPages } from "../../../src/lib/pagination";
import { verifyDialpadJwt } from "./jwt";
import {
  draftFromCall,
  draftFromSms,
  type CommunicationDraft,
} from "./decide";
import { resolveFiling, type Filing } from "./resolve";

/**
 * Dialpad → Communication rows. See ./resource.ts for why a Function URL and
 * ./jwt.ts for why the verification is hand-rolled and the algorithm pinned.
 *
 * The order below is the security property, not a style: verify, then parse,
 * then act. Nothing downstream sees the payload as anything but an opaque
 * string until the signature has matched.
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

const ok = (body: string): APIGatewayProxyResultV2 => ({ statusCode: 200, body });
const refused: APIGatewayProxyResultV2 = { statusCode: 401, body: "unauthorized" };

/**
 * The agency's people, by the two things a Dialpad event can name them with.
 *
 * One listing per container rather than a lookup per event, because a team is
 * a handful of rows and one call arrives as five to seven events. `UserProfile`
 * is indexed on `userId` and nothing else, so a per-event lookup would be a
 * filtered scan anyway.
 */
interface Producer {
  userId: string;
  name: string;
}
let producers: { byEmail: Map<string, Producer>; byDialpadId: Map<string, Producer> } | undefined;

async function getProducers(client: DataClient) {
  if (producers) return producers;
  const byEmail = new Map<string, Producer>();
  const byDialpadId = new Map<string, Producer>();
  try {
    const rows = await listAllPages((nextToken) =>
      client.models.UserProfile.list({ nextToken, limit: 200 })
    );
    for (const r of rows) {
      const who: Producer = {
        userId: r.userId,
        name: [r.firstName, r.lastName].filter(Boolean).join(" ").trim() || r.email,
      };
      if (r.email) byEmail.set(r.email.toLowerCase(), who);
      if (r.dialpadUserId) byDialpadId.set(String(r.dialpadUserId), who);
    }
  } catch (err) {
    // An unattributed call is still worth recording — it is the account's
    // history, not the producer's.
    console.error("dialpad-webhook: could not load producers", err);
  }
  producers = { byEmail, byDialpadId };
  return producers;
}

async function resolveProducer(
  client: DataClient,
  draft: CommunicationDraft
): Promise<Producer | null> {
  const { byEmail, byDialpadId } = await getProducers(client);
  // Email first: it needs no setup and stays correct as people join. The id
  // is the fallback for a Dialpad account whose email differs from the one
  // they sign in with.
  const email = draft.targetEmail?.toLowerCase();
  return (
    (email ? byEmail.get(email) : undefined) ??
    (draft.dialpadUserId ? byDialpadId.get(draft.dialpadUserId) : undefined) ??
    null
  );
}

/**
 * Who this conversation is with, and whose timelines it belongs on.
 *
 * A call the CRM placed itself carries the answer: `custom_data` was stamped
 * with the account and contact at dial time, so there is nothing to match and
 * nothing to be ambiguous about. Everything else goes through the phone index.
 */
async function fileFor(client: DataClient, draft: CommunicationDraft): Promise<Filing> {
  const stamped = draft.customData;
  if (stamped?.accountId) {
    return {
      confidence: "EXACT",
      contactId: stamped.contactId ?? null,
      contactName: draft.contactName,
      accountIds: [stamped.accountId],
      suppressed: false,
    };
  }

  const links = await listAllPages((nextToken) =>
    client.models.PhoneLink.listPhoneLinkByE164(
      { e164: draft.externalNumber },
      { nextToken, limit: 200 }
    )
  );
  const filing = resolveFiling(links);
  // Dialpad's own caller ID is better than nothing on a number we do not
  // know: it is what the triage queue shows a person to work from.
  return filing.contactName ? filing : { ...filing, contactName: draft.contactName };
}

/** The row this event belongs to, if an earlier event already created it. */
async function findExisting(client: DataClient, draft: CommunicationDraft) {
  if (draft.dialpadCallId) {
    const { data } = await client.models.Communication.listCommunicationByDialpadCallId(
      { dialpadCallId: draft.dialpadCallId },
      { limit: 1 }
    );
    return data?.[0] ?? null;
  }
  if (draft.dialpadMessageId) {
    const rows = await listAllPages((nextToken) =>
      client.models.Communication.listCommunicationByExternalNumberAndOccurredAt(
        { externalNumber: draft.externalNumber },
        { nextToken, limit: 200 }
      )
    );
    return rows.find((r) => r.dialpadMessageId === draft.dialpadMessageId) ?? null;
  }
  return null;
}

/**
 * Only the fields this event actually carries.
 *
 * An event is a partial description — `ringing` knows nothing about a
 * recording, `recap_summary` knows nothing about duration — so writing every
 * field on every event would have each one erase what the last established.
 */
function presentFields(draft: CommunicationDraft) {
  const out: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => {
    if (v !== null && v !== undefined) out[k] = v;
  };
  put("state", draft.state);
  put("durationSeconds", draft.durationSeconds);
  put("totalDurationSeconds", draft.totalDurationSeconds);
  put("wasRecorded", draft.wasRecorded);
  put("recordingId", draft.recordingId);
  put("recordingUrl", draft.recordingUrl);
  put("recapSummary", draft.recapSummary);
  put("recapActionItems", draft.recapActionItems);
  put("body", draft.body);
  put("mms", draft.mms);
  put("messageStatus", draft.messageStatus);
  put("internalNumber", draft.internalNumber);
  return out;
}

async function persist(
  client: DataClient,
  draft: CommunicationDraft,
  filing: Filing,
  producer: Producer | null
): Promise<void> {
  const existing = await findExisting(client, draft);

  if (existing) {
    // Deliveries are not ordered. A `ringing` that arrives after `hangup`
    // must not overwrite a finished call with an in-progress one.
    if (existing.lastEventAt && existing.lastEventAt >= draft.eventAt) return;
    const { errors } = await client.models.Communication.update({
      id: existing.id,
      lastEventAt: draft.eventAt,
      ...presentFields(draft),
    });
    if (errors?.length) {
      console.error("Communication update failed", JSON.stringify(errors));
    }
    return;
  }

  const { data: created, errors } = await client.models.Communication.create({
    channel: draft.channel,
    direction: draft.direction,
    dialpadCallId: draft.dialpadCallId ?? undefined,
    dialpadMessageId: draft.dialpadMessageId ?? undefined,
    externalNumber: draft.externalNumber,
    dialpadUserId: draft.dialpadUserId ?? undefined,
    userId: producer?.userId,
    userName: producer?.name,
    contactId: filing.contactId ?? undefined,
    contactName: filing.contactName ?? undefined,
    matchConfidence: filing.confidence,
    appearanceCount: filing.accountIds.length,
    occurredAt: draft.occurredAt,
    lastEventAt: draft.eventAt,
    ...presentFields(draft),
  });
  if (errors?.length || !created) {
    console.error("Communication create failed", JSON.stringify(errors));
    return;
  }

  // Appearances are written once, with the row. The number a call came from
  // does not change between its events, so the filing cannot either — and
  // rewriting them per event would fan out thirty writes seven times for one
  // call with a property manager.
  for (const accountId of filing.accountIds) {
    const { errors: linkErrors } = await client.models.CommunicationAccount.create({
      communicationId: created.id,
      accountId,
      occurredAt: draft.occurredAt,
    });
    if (linkErrors?.length) {
      console.error(
        `CommunicationAccount create failed for ${accountId}`,
        JSON.stringify(linkErrors)
      );
    }
  }
}

/**
 * Which kind of event this is.
 *
 * Both subscriptions post to one URL, and neither payload carries a type
 * field — they are told apart by shape. A call event has a `call_id`; an SMS
 * event has an `id` and a `from_number`.
 */
export function draftFor(claims: Record<string, unknown>): CommunicationDraft | null {
  if (claims.call_id !== undefined) return draftFromCall(claims);
  if (claims.id !== undefined && (claims.from_number !== undefined || claims.text !== undefined)) {
    return draftFromSms(claims);
  }
  return null;
}

export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  const secret = process.env.DIALPAD_WEBHOOK_SECRET;
  if (!secret) {
    // Refuse rather than accept unverified events. An endpoint that processes
    // whatever arrives because its secret is unset is worse than one that is
    // down: it is a public write nobody knows about.
    console.error("dialpad-webhook: DIALPAD_WEBHOOK_SECRET unset");
    return refused;
  }

  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : (event.body ?? "");

  const verified = verifyDialpadJwt(raw, secret);
  if (!verified.ok) {
    // The reason is logged and not returned: a caller probing this endpoint
    // learns only that it was refused.
    console.warn(`dialpad-webhook: refused (${verified.reason})`);
    return refused;
  }

  const draft = draftFor(verified.claims);
  // A signed event this does not model — an agent status change, a contact
  // update — is accepted and ignored. Returning an error would make Dialpad
  // retry something that will never be understood.
  if (!draft) return ok("ignored");

  try {
    const client = await getDataClient();
    const [filing, producer] = await Promise.all([
      fileFor(client, draft),
      resolveProducer(client, draft),
    ]);
    await persist(client, draft, filing, producer);
    return ok("recorded");
  } catch (err) {
    // 500 so Dialpad retries. The upsert is keyed on their id, so a retry
    // that lands twice writes one row.
    console.error("dialpad-webhook: failed to record", err);
    return { statusCode: 500, body: "error" };
  }
};
