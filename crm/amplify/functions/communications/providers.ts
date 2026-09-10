import { remainingDelay, rememberBudget, authorizationDelay, authorizationFailed, authorizationRestored } from "./budget";
import { get, row, put, commit, hash } from "./store";
import { credentials, config } from "./config";
import { normalizePhone } from "../../../../shared/leadWorkflow";

export class ProviderError extends Error {
  constructor(message: string, public status: number, public uncertain: boolean, public retryAfter = 60) { super(message); }
}
export class FrontScopeError extends Error {}
export async function providerRequest<T = Record<string, unknown>>(provider: "front" | "dialpad", path: string, method = "GET", body?: unknown, redirects = 0, inboxScopeProbe = false): Promise<T> {
  const base = provider === "front" ? "https://api2.frontapp.com" : "https://dialpad.com/api/v2";
  const key = (await credentials())[provider === "front" ? "frontToken" : "dialpadToken"];
  if (!key) throw new ProviderError(`${provider === "front" ? "Front" : "Dialpad"} credentials need setup`, 401, false);
  const fingerprint = hash(key), authDelay = await authorizationDelay(provider, fingerprint);
  if (authDelay) throw new ProviderError(`${provider} authorization is waiting for repair`, 401, false, authDelay);
  let url = new URL(path.startsWith("http") ? path : `${base}${path}`);
  if (provider === "front" && /^[a-z0-9-]+\.api\.frontapp\.com$/.test(url.hostname) && url.protocol === "https:") url = new URL(url.pathname + url.search, base);
  if (url.origin !== new URL(base).origin || (provider === "dialpad" && !url.pathname.startsWith("/api/v2/"))) throw new Error("Untrusted provider URL");
  const delay = await remainingDelay(provider, path.includes("/seen") || path.includes("/search/"));
  if (delay) throw new ProviderError(`${provider} API budget is waiting to reset`, 429, false, delay);
  let response: Response;
  try {
    response = await fetch(url, { method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
      redirect: "manual", signal: AbortSignal.timeout(12_000) });
  } catch { throw new ProviderError(`${provider} request could not be confirmed`, 0, method !== "GET"); }
  await rememberBudget(provider, response).catch(() => {});
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (method === "GET" && provider === "front" && location && redirects < 3) {
      const moved = new URL(location, url);
      if (moved.origin !== url.origin || !/^\/conversations\/cnv_[a-z0-9]+(?:\/|$)/.test(moved.pathname)) throw new Error("Untrusted Front redirect");
      return providerRequest<T>(provider, moved.href, "GET", undefined, redirects + 1, inboxScopeProbe);
    }
    // Mutations are never implicitly changed into GET by a redirect.
    throw new ProviderError(`${provider} resource moved; refresh its verified conversation link`, response.status, false);
  }
  // A company-wide hook can name a conversation outside this token's workspace.
  // Its denied metadata lookup must not pause every authorized send.
  if (response.status === 403 && provider === "front" && method === "GET" && inboxScopeProbe) throw new FrontScopeError("Conversation is unavailable within the Front token's inbox scope");
  if ([401, 403].includes(response.status)) {
    const delay = await authorizationFailed(provider, fingerprint).catch(() => 60);
    throw new ProviderError(`${provider} authorization needs repair`, response.status, false, delay);
  }
  if (response.ok) await authorizationRestored(provider, fingerprint).catch(() => {});
  if (!response.ok) throw new ProviderError(`${provider} returned ${response.status}`, response.status,
    method !== "GET" && response.status >= 500, Math.max(1, Number(response.headers.get("retry-after")) || 60));
  if (response.status === 204) return {} as T;
  return response.json() as Promise<T>;
}
export async function front<T = Record<string, unknown>>(path: string, method = "GET", body?: unknown): Promise<T> {
  const match = path.match(/^\/conversations\/(cnv_[a-z0-9]+)(?=\/|$|\?)/);
  if (match && method !== "GET") {
    const alias = await get<{ conversationId: string }>(`front-alias:${match[1]}`);
    if (alias) path = path.replace(match[1], alias.data.conversationId);
  }
  return providerRequest<T>("front", path, method, body);
}
export const dialpad = <T = Record<string, unknown>>(path: string) => providerRequest<T>("dialpad", path);
export function dialpadCallItems(page: unknown): Record<string, unknown>[] {
  if (page && typeof page === "object" && !Array.isArray(page)) {
    // The live API serializes an empty concluded-call window as {}, without items.
    if (!Object.keys(page).length) return [];
    const items = (page as { items?: unknown }).items;
    if (Array.isArray(items)) return items;
  }
  throw new Error("Dialpad call-history response needs review");
}
export const htmlEscape = (value: string) => value.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));
export interface FrontMessage { id: string; message_uid?: string; uid?: string; created_at: number; is_inbound: boolean; type?: string; text?: string; body?: string; subject?: string;
  attachments?: { id: string; filename: string; content_type: string; size: number }[];
  author?: { id: string }; recipients?: { handle: string; role: string }[]; conversation?: { id: string }; _links?: { related?: { conversation?: string } }; metadata?: Record<string, unknown> }
export async function permittedConversation(id: string) {
  if (!/^cnv_[a-z0-9]+$/.test(id)) throw new Error("Invalid Front conversation ID");
  const [inboxes, settings] = await Promise.all([
    providerRequest<{ _results: { id: string }[] }>("front", `/conversations/${id}/inboxes`, "GET", undefined, 0, true), config(),
  ]);
  if (!Array.isArray(inboxes._results)) throw new Error("Front inbox membership could not be verified");
  if (!inboxes._results.some(x => [settings.frontInboxId, ...settings.allowedInboxIds].includes(x.id))) throw new FrontScopeError("Conversation is outside the configured inboxes");
  const conversation = await front<{ id: string; status: string; assignee?: { id: string }; last_message?: FrontMessage }>(`/conversations/${id}`);
  if (conversation.id !== id) {
    if (!/^cnv_[a-z0-9]+$/.test(conversation.id)) throw new Error("Invalid canonical Front conversation");
    const source = await get<{ accountId: string; conversationId: string }>(`front-link:${id}`), target = await get<{ accountId: string }>(`front-link:${conversation.id}`);
    if (source && target && source.data.accountId !== target.data.accountId) throw new Error("Merged conversations belong to different leads; review their links");
    const alias = await get(`front-alias:${id}`);
    if (!alias || alias.data.conversationId !== conversation.id) {
      const writes = [put(row("ALIAS", `front-alias:${id}`, { conversationId: conversation.id }, { previous: alias }), alias)];
      if (source && !target) writes.push(put(row("LINK", `front-link:${conversation.id}`, { ...source.data, conversationId: conversation.id }, { accountId: source.data.accountId })));
      await commit(writes);
    }
  }
  return conversation;
}
export async function assertRecipient(email: string) {
  const c = await config();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("A valid prospect email is required");
  if (c.environment !== "main" && !c.testRecipients.map(x => x.toLowerCase()).includes(email.toLowerCase())) throw new Error("This recipient is not on the staging test list");
}
export function messageConversation(message: FrontMessage): string | undefined {
  const id = message.conversation?.id ?? message._links?.related?.conversation?.split("/").pop();
  return id && /^cnv_[a-z0-9]+$/.test(id) ? id : undefined;
}

export async function verifyEmailChannel() {
  const c = await config();
  if (!c.frontChannelId) throw new ProviderError("Configure the shared Front sales channel", 0, false);
  const scope = `front-channel:${c.frontChannelId}`, fingerprint = hash(`${(await credentials()).frontToken}:${c.version}`);
  const delay = await authorizationDelay(scope, fingerprint);
  if (delay) throw new ProviderError("Reconnect the shared Front mailbox", 401, false, delay);
  const channel = await front<{ type: string; address?: string; send_as?: string; is_valid?: boolean; _links?: { related?: { inbox?: string } } }>(`/channels/${c.frontChannelId}`);
  if (channel.is_valid === false) {
    const delay = await authorizationFailed(scope, fingerprint);
    throw new ProviderError("Reconnect the shared Front mailbox before queued email can resume", 401, false, delay);
  }
  await authorizationRestored(scope, fingerprint);
  if (!["gmail", "office365", "imap", "smtp", "front_mail"].includes(channel.type) || (channel.send_as || channel.address)?.toLowerCase() !== c.frontSender.toLowerCase()) throw new Error("The Front channel must be a valid email channel using the configured sales address");
  if (channel._links?.related?.inbox?.split("/").pop() !== c.frontInboxId) throw new Error("The sales email channel must belong to the configured sales inbox");
  return channel;
}
export async function verifySmsChannel() {
  const c = await config();
  if (!c.frontSmsChannelId) throw new Error("Connect the native Dialpad shared SMS channel");
  const channel = await front<{ type?: string; address?: string; send_as?: string; is_valid?: boolean }>(`/channels/${c.frontSmsChannelId}`);
  // Native Dialpad channels expose an address such as +15082332261_sms;
  // send_as is the actual customer-facing number. A voice channel is not SMS.
  const sender = channel.send_as || channel.address?.replace(/_sms$/, "");
  if (channel.type !== "dialpad_sms" || !sender || normalizePhone(sender) !== c.sharedSmsNumber || channel.is_valid === false) throw new Error("The configured text channel no longer matches the main line");
  return channel;
}
export async function verifyDialpadCompany() {
  const c = await config();
  if (!c.dialpadCompanyId) throw new Error("Enter the Dialpad company ID");
  // A company API key has no /users/me identity. The company endpoint also
  // proves the administrator access needed for all configured business lines.
  const company = await dialpad<{ id?: string | number }>("/company");
  if (String(company.id) !== c.dialpadCompanyId) throw new Error("Dialpad company does not match settings");
  return company;
}
export function providerTimestamp(value: string | number): number {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  return Date.parse(String(value));
}
