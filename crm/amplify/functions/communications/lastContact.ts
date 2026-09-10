import type { Communication } from "../../../../shared/leadWorkflow";
import { get, query, type Row } from "./store";
export interface ContactStamp { at: string; channel: string; direction: string }
export function contactCandidate(c: Communication): boolean {
  return ["EMAIL", "CALL", "SMS"].includes(c.channel) && ["INBOUND", "OUTBOUND"].includes(c.direction)
    && c.classification !== "AUTOMATIC" && !["UNRELATED", "WRONG_NUMBER"].includes(c.outcome ?? "")
    && !["FAILED", "REJECTED", "UNDELIVERED", "IN_PROGRESS", "QUEUED", "PENDING"].includes(c.status)
    && Number.isFinite(Date.parse(c.at));
}
/** Existing account index is ordered by event time. Read one bounded page,
 * with no message bodies in the response. The caller follows cursors until
 * the latest prospect contact is found, including for historical leads. */
export async function lastContactPage(accountId: string, nextToken?: string) {
  const page = await query<Communication>("account", accountId, nextToken, 25, "COMMUNICATION#");
  const links = new Map<string, Row<{ accountId?: string; purpose?: string }> | undefined>();
  const link = async (key: string) => {
    if (!links.has(key)) links.set(key, await get<{ accountId?: string; purpose?: string }>(key));
    return links.get(key);
  };
  let contact: ContactStamp | null = null;
  for (const candidate of page.items) {
    // GSI projections can lag edits, unions, and linking. Read the current
    // record before counting it; redirects and removed links never count.
    if (!contactCandidate(candidate.data)) continue;
    const current = await get<Communication>(candidate.id);
    if (!current || current.kind !== "COMMUNICATION" || current.accountId !== accountId || !contactCandidate(current.data)) continue;
    const c = current.data;
    const exact = await link(`activity-link:${c.id}`);
    const conversation = c.conversationId ? await link(`front-link:${c.conversationId}`) : undefined;
    const purpose = exact?.data.purpose ?? conversation?.data.purpose;
    if (purpose === "CARRIER" || (c.channel === "EMAIL" && purpose !== "PROSPECT")) continue;
    if ((exact && exact.data.accountId !== accountId) || (conversation && conversation.data.accountId !== accountId)) continue;
    if (!contact || c.at > contact.at) contact = { at: c.at, channel: c.channel, direction: c.direction };
  }
  // A call union can move its actual time earlier than its old index key.
  // Continue in that case instead of trusting the first indexed candidate.
  const oldestIndexedAt = page.items.at(-1)?.accountSort?.slice("COMMUNICATION#".length, "COMMUNICATION#".length + 24);
  const complete = !page.nextToken || !!(contact && oldestIndexedAt && contact.at >= oldestIndexedAt);
  return { accountId, contact, nextToken: complete ? undefined : page.nextToken, complete };
}
