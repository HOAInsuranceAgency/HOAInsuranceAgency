import type { TeamEligibility } from "../../../../shared/leadWorkflow";
import { config } from "./config";
import { frontPersonalResource, ProviderError } from "./providers";

export interface ProducerEmailIdentity {
  frontId: string; channelId: string; senderEmail: string; signatureId: string; signatureMode: "FRONT";
}
interface OwnedResource { id?: unknown; _links?: { related?: { owner?: unknown } } }
interface Channel extends OwnedResource { type?: unknown; address?: unknown; send_as?: unknown; is_valid?: unknown; is_private?: unknown }
interface Signature extends OwnedResource { body?: unknown; channel_ids?: unknown; is_default?: unknown; is_private?: unknown }
const emailTypes = new Set(["gmail", "office365", "imap", "smtp", "front_mail"]);
export class ProducerEmailSetupError extends ProviderError {
  constructor(message: string) { super(`${message}. Check the salesperson's Team connections`, 0, false, 60); }
}
const setup = (message: string) => new ProducerEmailSetupError(message);

function ownerMatches(resource: OwnedResource, frontId: string): boolean {
  const value = resource._links?.related?.owner;
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.search && !url.hash &&
      (url.hostname === "api2.frontapp.com" || /^[a-z0-9-]+\.api\.frontapp\.com$/.test(url.hostname)) && url.pathname === `/teammates/${frontId}`;
  } catch { return false; }
}
function emailAddress(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 254 || value !== value.trim()) return;
  const parts = value.split("@"), local = parts[0], domain = parts[1];
  if (parts.length !== 2 || !local || local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..") ||
    !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) || !domain || !domain.includes(".") ||
    domain.split(".").some(label => !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))) return;
  return value.toLowerCase();
}
function sender(channel: Channel): string | undefined {
  return emailAddress(channel.send_as === undefined || channel.send_as === "" ? channel.address : channel.send_as);
}
function signatureHasContent(body: unknown): boolean {
  if (typeof body !== "string") return false;
  // Front's rich-text editor can save an empty paragraph as nonempty HTML.
  const visible = body.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  return Boolean(visible.replace(/<[^>]*>/g, "").replace(/&nbsp;|&#160;|&#x0*a0;/gi, " ").trim()) ||
    /<img\b[^>]*\bsrc\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>]+)/i.test(visible);
}

/** Read the complete personal collection before deciding that an identity is unique. */
async function resources<T extends OwnedResource>(frontId: string, kind: "channels" | "signatures"): Promise<T[]> {
  const pathname = `/teammates/${frontId}/${kind}`, results: T[] = [], ids = new Set<string>(), visited = new Set<string>();
  let next: string | undefined = pathname;
  for (let page = 0; next && page < 20; page++) {
    const url = new URL(next, "https://api2.frontapp.com");
    // A provider cursor may change only the page, never the teammate or resource.
    if (url.pathname !== pathname || visited.has(url.pathname + url.search)) throw setup("Front personal mailbox/signature pagination could not be verified");
    visited.add(url.pathname + url.search);
    const response: { _results?: unknown; _pagination?: { next?: unknown } } = await frontPersonalResource(next);
    if (!Array.isArray(response?._results)) throw setup("Front personal mailbox/signature response could not be verified");
    for (const item of response._results) {
      if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.id !== "string" || ids.has(item.id)) throw setup("Front personal mailbox/signature response could not be verified");
      ids.add(item.id); results.push(item as T);
      if (results.length > 1_000) throw setup("Front personal mailbox/signature list is too large to verify");
    }
    const cursor = response._pagination?.next;
    if (cursor !== undefined && cursor !== null && (typeof cursor !== "string" || !cursor)) throw setup("Front personal mailbox/signature pagination could not be verified");
    next = typeof cursor === "string" ? cursor : undefined;
  }
  if (next) throw setup("Front personal mailbox/signature pagination could not be completed");
  return results;
}

/** Resolve the actual From mailbox and Front signature; CRM login email is not a mailbox mapping. */
export async function resolveProducerEmail(member: TeamEligibility): Promise<ProducerEmailIdentity> {
  const frontId = member.frontId;
  if (!frontId || !/^tea_[a-z0-9]+$/.test(frontId)) throw setup("Connect the salesperson's Front teammate");
  if (member.frontChannelId && !/^cha_[a-z0-9]+$/.test(member.frontChannelId)) throw setup("The salesperson's Front email channel ID is invalid");
  if (member.frontSignatureId && !/^sig_[a-z0-9]+$/.test(member.frontSignatureId)) throw setup("The salesperson's Front signature ID is invalid");
  const channels = await resources<Channel>(frontId, "channels");
  const validChannels = channels.filter(channel => typeof channel.id === "string" && /^cha_[a-z0-9]+$/.test(channel.id) &&
    ownerMatches(channel, frontId) && channel.is_private === true && channel.is_valid === true &&
    typeof channel.type === "string" && emailTypes.has(channel.type) && sender(channel));
  let channel: Channel | undefined;
  if (member.frontChannelId) channel = validChannels.find(item => item.id === member.frontChannelId);
  else if (validChannels.length === 1) channel = validChannels[0];
  else if (validChannels.length > 1) {
    const agencyDomain = emailAddress((await config()).frontSender)?.split("@")[1];
    const matching = agencyDomain ? validChannels.filter(item => sender(item)?.split("@")[1] === agencyDomain) : [];
    if (matching.length === 1) channel = matching[0];
  }
  if (!channel) throw setup(member.frontChannelId ? "The selected Front email channel is not a connected personal mailbox owned by this salesperson" :
    validChannels.length ? "Choose the salesperson's Front email channel because more than one personal mailbox is available" : "Connect a valid personal email mailbox for the salesperson in Front");
  const signatures = await resources<Signature>(frontId, "signatures");
  const applicable = signatures.filter(signature => typeof signature.id === "string" && /^sig_[a-z0-9]+$/.test(signature.id) &&
    ownerMatches(signature, frontId) && signature.is_private === true && signatureHasContent(signature.body) &&
    (signature.channel_ids === null || (Array.isArray(signature.channel_ids) && signature.channel_ids.every(id => typeof id === "string" && /^cha_[a-z0-9]+$/.test(id)) && signature.channel_ids.includes(channel.id))));
  let signature: Signature | undefined;
  if (member.frontSignatureId) signature = applicable.find(item => item.id === member.frontSignatureId);
  else {
    const defaults = applicable.filter(item => item.is_default === true);
    if (defaults.length === 1) signature = defaults[0];
    else if (!defaults.length && applicable.length === 1) signature = applicable[0];
  }
  if (!signature) throw setup(member.frontSignatureId ? "The selected Front signature is not an applicable personal signature owned by this salesperson" :
    applicable.length ? "Choose the salesperson's Front signature because more than one is available" : "Add a personal Front email signature for the salesperson's mailbox");
  return { frontId, channelId: channel.id as string, senderEmail: sender(channel)!, signatureId: signature.id as string, signatureMode: "FRONT" };
}
