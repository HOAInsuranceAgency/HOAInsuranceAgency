import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { MarketingReportRun, MarketingReportSettings } from "../../../../shared/marketingReportSettings";
import { db, table, get, row, save, commit, put, check, absent, conflict, hash, type Row } from "../communications/store";

export const SETTINGS_ID = "marketing-report:settings";
export const RUN_KIND = "MARKETING_REPORT_RUN";
export type Run = MarketingReportRun & { actor?: string; sendStartedAt?: string; messageId?: string };
export const environment = () => process.env.MARKETING_REPORT_ENV ?? "local";
export const schedule = { day: "Friday", time: "08:00", timeZone: "America/New_York" } as const;
export const defaultSettings = (): MarketingReportSettings => ({ version: 0, enabled: false, recipient: "" });
export const readSettings = () => get<MarketingReportSettings>(SETTINGS_ID);
export const readRun = (id: string) => get<Run>(id);

export function validEmail(value: unknown): string {
  if (typeof value !== "string" || value.length > 254 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(value.trim())) throw new Error("Enter one valid recipient email address.");
  return value.trim().toLowerCase();
}
export async function assertRecipient(recipient: string) {
  validEmail(recipient);
  if (environment() === "main") return;
  const config = await get<{ testRecipients?: unknown }>("config");
  const allowed = config?.data.testRecipients;
  if (!Array.isArray(allowed) || !allowed.some(value => typeof value === "string" && value.toLowerCase() === recipient.toLowerCase())) throw new Error("This deployment can send only to an approved test recipient in Communication settings.");
}
export async function saveSettings(input: Record<string, unknown>) {
  const old = await readSettings();
  if (!Number.isInteger(input.version) || input.version !== (old?.version ?? 0)) throw new Error("Settings changed. Refresh and try again.");
  if (typeof input.enabled !== "boolean") throw new Error("Choose whether weekly delivery is enabled.");
  const recipient = input.recipient === "" && !input.enabled ? "" : validEmail(input.recipient);
  if (input.enabled && environment() !== "main") throw new Error("Weekly delivery can be enabled only in production.");
  if (recipient) await assertRecipient(recipient);
  const next = row("MARKETING_REPORT_SETTINGS", SETTINGS_ID, { version: (old?.version ?? 0) + 1, enabled: input.enabled, recipient }, { previous: old });
  try { await save(next, old); } catch (error) { if (conflict(error)) throw new Error("Settings changed. Refresh and try again."); throw error; }
  return next;
}
export const manualRunId = (requestId: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) throw new Error("A valid request ID is required.");
  return `marketing-report:run:manual:${hash(requestId.toLowerCase())}`;
};
export function runRecord(data: Run, old?: Row<Run>): Row<Run> {
  return { ...row(RUN_KIND, data.id, data, { previous: old }), workKind: RUN_KIND, workAt: data.createdAt };
}
export async function updateRun(old: Row<Run>, values: Partial<Run>) {
  const next = runRecord({ ...old.data, ...values, updatedAt: new Date().toISOString() }, old);
  await save(next, old);
  return next;
}
/** The settings version is checked in the same transaction as the run reservation. */
export async function reserveRun(id: string, kind: "manual" | "scheduled", settings: Row<MarketingReportSettings>, asOf: string, actor?: string) {
  const existing = await readRun(id);
  if (existing) return { record: existing, created: false };
  const next = runRecord({ id, kind, status: "queued", recipient: settings.data.recipient, asOf, createdAt: asOf, updatedAt: asOf, ...(actor ? { actor } : {}) });
  try { await commit([put(next), settings.version ? check(settings) : absent(SETTINGS_ID)]); }
  catch (error) { if (!conflict(error)) throw error; const winner = await readRun(id); if (winner) return { record: winner, created: false }; throw new Error("Settings changed. Refresh and try again."); }
  return { record: next, created: true };
}
/** A timed-out job is never resubmitted automatically: an uncertain send needs review. */
export async function reconcileStale(record: Row<Run>, now = Date.now()) {
  if (!["queued", "sending"].includes(record.data.status) || now - Date.parse(record.data.updatedAt) < 10 * 60_000) return record;
  try { return await updateRun(record, record.data.status === "queued"
    ? { status: "failed", retryable: true, error: "The report did not start. Review the worker before requesting another report." }
    : { status: "unknown", retryable: false, error: "The worker stopped before confirming delivery. Check the recipient inbox and email service before sending again." }); }
  catch (error) { if (!conflict(error)) throw error; return await readRun(record.id) ?? record; }
}
export async function settingsSnapshot() {
  const [settings, latest] = await Promise.all([readSettings(), db.send(new QueryCommand({ TableName: table(), IndexName: "work", KeyConditionExpression: "workKind = :kind", ExpressionAttributeValues: { ":kind": RUN_KIND }, ScanIndexForward: false, Limit: 10 }))]);
  const recentRuns = await Promise.all(((latest.Items ?? []) as Row<Run>[]).map(reconcile => reconcileStale(reconcile).then(result => result.data)));
  return { ok: true as const, settings: settings ? { ...settings.data, version: settings.version } : defaultSettings(), schedule, environment: environment(), recentRuns };
}
export { conflict };
