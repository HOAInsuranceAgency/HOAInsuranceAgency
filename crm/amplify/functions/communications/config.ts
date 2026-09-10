import { SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import type { IntegrationConfig } from "../../../../shared/leadWorkflow";
import { get, row, put, commit, type Write } from "./store";

export interface Credentials { frontToken?: string; frontSigningKey?: string; dialpadToken?: string; dialpadSigningKey?: string }
const secrets = new SecretsManagerClient();
let cached: { at: number; value: Credentials } | undefined;
export async function credentials(): Promise<Credentials> {
  if (cached && Date.now() - cached.at < 30_000) return cached.value;
  if (!process.env.COMMUNICATION_SECRET) throw new Error("Communication credentials are not configured");
  const result = await secrets.send(new GetSecretValueCommand({ SecretId: process.env.COMMUNICATION_SECRET }));
  const value = JSON.parse(result.SecretString ?? "{}") as Credentials;
  cached = { at: Date.now(), value };
  return value;
}
export async function saveCredentials(input: Credentials) {
  const before = await credentials();
  const next = { ...before };
  for (const key of ["frontToken", "frontSigningKey", "dialpadToken", "dialpadSigningKey"] as const) {
    if (input[key]?.trim()) next[key] = input[key]!.trim();
  }
  await secrets.send(new PutSecretValueCommand({ SecretId: process.env.COMMUNICATION_SECRET, SecretString: JSON.stringify(next) }));
  cached = undefined;
}
/** Old saved rows and cached clients may still include the retired toggle. */
function currentSettings(input: IntegrationConfig & { cleanupEnabled?: unknown }): IntegrationConfig {
  const { cleanupEnabled: _retired, ...settings } = input;
  return settings;
}
export async function config(): Promise<IntegrationConfig> {
  const existing = await get<IntegrationConfig>("config");
  return existing ? currentSettings({ ...existing.data, version: existing.version }) : {
    environment: process.env.COMMUNICATION_ENV ?? "local", frontSender: process.env.AGENCY_MAILBOX ?? "jake+testing@protectmyhoa.com",
    holidays: [], paused: true, allowedInboxIds: [], testRecipients: [], dialpadNumbers: [], sharedSmsNumber: "+15082332261", version: 0,
  };
}
export async function saveConfig(input: IntegrationConfig, activating = false, auditWrites: Write[] = []) {
  input = currentSettings(input);
  const old = await get<IntegrationConfig>("config");
  if (!Array.isArray(input.allowedInboxIds) || !Array.isArray(input.holidays) || !Array.isArray(input.testRecipients) || typeof input.frontSender !== "string") throw new Error("Invalid integration settings");
  if (old?.data.activatedAt && (input.frontCompanyId !== old.data.frontCompanyId || input.dialpadCompanyId !== old.data.dialpadCompanyId)) throw new Error("Changing connected companies requires a separate migration of existing conversation links");
  const scopeChanged = old && ["frontInboxId", "frontChannelId", "frontSmsChannelId", "allowedInboxIds", "dialpadNumbers", "dialpadOfficeId"].some(key => JSON.stringify(input[key as keyof IntegrationConfig]) !== JSON.stringify(old.data[key as keyof IntegrationConfig]));
  if (!activating && scopeChanged) input = { ...input, paused: true };
  if (!activating) input = { ...input, activatedAt: old?.data.activatedAt, paused: !old?.data.activatedAt || input.paused };
  if (input.version !== (old?.version ?? 0)) throw new Error("Settings changed. Refresh and try again.");
  const environment = process.env.COMMUNICATION_ENV ?? "local";
  if (input.environment !== environment) throw new Error("The settings environment does not match this deployment");
  if (environment === "main" && input.frontSender.toLowerCase() !== "sales@protectmyhoa.com") throw new Error("Production lead email uses sales@protectmyhoa.com");
  if (environment !== "main" && input.frontSender.toLowerCase() === "sales@protectmyhoa.com") throw new Error("Production sender cannot be used in a test deployment");
  for (const id of [...input.allowedInboxIds, input.frontInboxId].filter(Boolean)) if (!/^inb_[a-z0-9]+$/.test(id!)) throw new Error("Invalid Front inbox ID");
  if (input.frontChannelId && !/^cha_[a-z0-9]+$/.test(input.frontChannelId)) throw new Error("Invalid Front email channel ID");
  if (input.holidays.length > 366 || input.holidays.some(x => !/^\d{4}-\d{2}-\d{2}$/.test(x) || !Number.isFinite(Date.parse(x)) || new Date(x).toISOString().slice(0, 10) !== x)) throw new Error("Use valid holiday dates");
  if (input.frontSmsChannelId && !/^cha_[a-z0-9]+$/.test(input.frontSmsChannelId)) throw new Error("Invalid shared text channel ID");
  if (input.frontCompanyId && !/^cmp_[a-z0-9]+$/.test(input.frontCompanyId)) throw new Error("Invalid Front company ID");
  if (input.dialpadCompanyId && !/^\d+$/.test(input.dialpadCompanyId)) throw new Error("Invalid Dialpad company ID");
  if (input.dialpadOfficeId && !/^\d+$/.test(input.dialpadOfficeId)) throw new Error("Invalid Dialpad office ID");
  if (input.testRecipients.some(e => typeof e !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))) throw new Error("Invalid test recipient");
  const next = row("CONFIG", "config", { ...input, version: (old?.version ?? 0) + 1 }, { previous: old });
  await commit([put(next, old), ...auditWrites]);
  return next.data;
}
