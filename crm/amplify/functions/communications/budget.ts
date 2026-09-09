import { get, row, save } from "./store";
type Budget = { remaining?: number; resetAt?: number; blockedUntil?: number };
export async function remainingDelay(provider: string, optional: boolean) {
  const state = await get<Budget>(`budget:${provider}`);
  if (!state) return 0;
  const now = Date.now();
  if ((state.data.blockedUntil ?? 0) > now) return Math.ceil((state.data.blockedUntil! - now) / 1000);
  if (optional && (state.data.remaining ?? Infinity) < 10 && (state.data.resetAt ?? 0) > now) return Math.ceil((state.data.resetAt! - now) / 1000);
  return 0;
}
export async function rememberBudget(provider: string, response: Response) {
  const header = response.headers.get("x-ratelimit-remaining");
  if (header === null && response.status !== 429) return;
  const id = `budget:${provider}`, old = await get<Budget>(id), reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
  const incoming = header === null ? undefined : Number(header);
  const sameWindow = old?.data.resetAt === reset;
  const data: Budget = { remaining: sameWindow ? Math.min(old?.data.remaining ?? Infinity, incoming ?? Infinity) : incoming, resetAt: reset || old?.data.resetAt,
    blockedUntil: response.status === 429 ? Math.max(old?.data.blockedUntil ?? 0, Date.now() + (Number(response.headers.get("retry-after")) || 60) * 1000) : old?.data.blockedUntil };
  if (!Number.isFinite(data.remaining)) data.remaining = undefined;
  try { await save(row("BUDGET", id, data, { previous: old }), old); } catch { /* The request result still matters; a concurrent response may have stored a newer budget. */ }
}

// Shared authorization cooldowns prevent every queued item probing a broken
// token. A changed credential fingerprint can validate immediately.
type AuthorizationHold = { fingerprint: string; failures: number; until: number };
export async function authorizationDelay(scope: string, fingerprint: string) {
  const hold = await get<AuthorizationHold>(`auth-hold:${scope}`);
  return hold?.data.fingerprint === fingerprint ? Math.max(0, Math.ceil((hold.data.until - Date.now()) / 1000)) : 0;
}
export async function authorizationFailed(scope: string, fingerprint: string) {
  const id = `auth-hold:${scope}`, old = await get<AuthorizationHold>(id);
  const failures = (old?.data.fingerprint === fingerprint ? old.data.failures : 0) + 1;
  const delay = Math.min(3600, 60 * 2 ** Math.min(failures - 1, 6));
  await save(row("AUTH_HOLD", id, { fingerprint, failures, until: Date.now() + delay * 1000 }, { previous: old }), old);
  return delay;
}
export async function authorizationRestored(scope: string, fingerprint: string) {
  const id = `auth-hold:${scope}`, old = await get<AuthorizationHold>(id);
  if (old && (old.data.failures || old.data.fingerprint !== fingerprint)) await save(row("AUTH_HOLD", id, { fingerprint, failures: 0, until: 0 }, { previous: old }), old);
}
