import { get, save, row } from "./store";

export async function resolveIssue(id: string) {
  const old = await get(`issue:${id}`);
  if (old && !old.data.resolved) await save(row("ISSUE", old.id, { ...old.data, resolved: true, resolvedAt: new Date().toISOString() }, { previous: old, accountId: old.accountId }), old);
}
