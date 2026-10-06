import { createHash } from "node:crypto";
import type { ActiveRole } from "../crm-access/active-role";
import { dataClient } from "./data";

const stages = ["LEAD", "CLIENT"] as const;
const resultLimit = 25;
const readLimit = 4;
const tokenLimit = 16384;
type Cursor = { version: 1; scope: string; stage: 0 | 1; token?: string };
type Match = { id: string; name: string };

function cursor(input: unknown, scope: string): Cursor {
  if (input === undefined || input === null) return { version: 1, scope, stage: 0 };
  try {
    if (typeof input !== "string" || !input.length || input.length > 24000 || !/^[\w-]+$/.test(input)) throw new Error();
    const value = JSON.parse(Buffer.from(input, "base64url").toString("utf8")) as Cursor;
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some(key => !["version", "scope", "stage", "token"].includes(key))
      || value.version !== 1 || value.scope !== scope || ![0, 1].includes(value.stage)
      || (value.token !== undefined && (typeof value.token !== "string" || !value.token.length || value.token.length > tokenLimit))) throw new Error();
    return value;
  } catch { throw new Error("Search changed. Start the search again."); }
}

/** Traverse the existing stage index in bounded segments. Case-insensitive
 * substring matching is performed here because the name index is case-sensitive.
 * An empty segment with a cursor is not an exhausted search. The custom-post
 * access guard rechecks current assignments before any candidate reaches the UI. */
export async function searchAccounts(input: Record<string, unknown>, identity: { actor: string; role?: ActiveRole }) {
  if (typeof input.query !== "string" || !input.query.trim() || input.query.trim().length > 200) {
    throw new Error("Enter an account name of 1 to 200 characters.");
  }
  if (!identity.actor) throw new Error("Sign in to search accounts.");
  const query = input.query.trim().toLowerCase();
  const scope = createHash("sha256").update(JSON.stringify([identity.actor, identity.role ?? null, query])).digest("hex");
  const position = cursor(input.nextToken, scope);
  const client = await dataClient();
  const items: Match[] = [], seen = new Set<string>();
  const visited = new Set<string>();
  let stage: number = position.stage, token = position.token;
  for (let reads = 0; reads < readLimit && stage < stages.length && items.length < resultLimit; reads++) {
    const pageKey = JSON.stringify([stage, token ?? null]);
    if (visited.has(pageKey)) throw new Error("Account search did not advance. Try again.");
    visited.add(pageKey);
    // Fetch no more candidates than the remaining result capacity, so no
    // matching row is discarded when advancing the service's opaque cursor.
    const limit = resultLimit - items.length;
    const page = await client.models.Account.listAccountByStageAndName({ stage: stages[stage] }, {
      limit, nextToken: token, selectionSet: ["id", "name"],
    });
    if (page.errors?.length || !Array.isArray(page.data) || page.data.length > limit
      || (page.nextToken != null && (typeof page.nextToken !== "string" || !page.nextToken.length || page.nextToken.length > tokenLimit))) {
      throw new Error("Could not search accounts. Try again.");
    }
    for (const account of page.data) {
      if (!account || typeof account.id !== "string" || !account.id || typeof account.name !== "string") {
        throw new Error("Could not search accounts. Try again.");
      }
      if (account.name.toLowerCase().includes(query) && !seen.has(account.id)) {
        items.push({ id: account.id, name: account.name });
        seen.add(account.id);
      }
    }
    if (page.nextToken) {
      if (visited.has(JSON.stringify([stage, page.nextToken]))) throw new Error("Account search did not advance. Try again.");
      token = page.nextToken;
    } else { stage++; token = undefined; }
  }
  return { items, ...(stage < stages.length ? {
    nextToken: Buffer.from(JSON.stringify({ version: 1, scope, stage: stage === 0 ? 0 : 1, ...(token ? { token } : {}) } satisfies Cursor)).toString("base64url"),
  } : {}) };
}
