import { client } from "./client";
import { isRecord, privateApiResponse, privateApiError } from './apiResponse';
import type { ApiRecord, ApiResponse } from '../../../shared/apiResponse';
import type { MarketingReportRun, MarketingReportSettings, MarketingReportSettingsSnapshot } from "../../../shared/marketingReportSettings";

function unwrap<T>(response: ApiResponse, validate: (value: ApiRecord) => value is ApiRecord & T): T {
  try { return privateApiResponse(response, validate, { fallback: 'The marketing report request could not be completed.' }); }
  catch (error) {
    if (error instanceof Error && error.message === 'Administrator access is required.') error.name = 'Unauthorized';
    throw error;
  }
}

function run(value: unknown): value is MarketingReportRun {
  return isRecord(value) && ['id', 'recipient', 'asOf', 'createdAt', 'updatedAt'].every(key => typeof value[key] === 'string')
    && ['scheduled', 'manual'].includes(String(value.kind)) && ['queued', 'sending', 'sent', 'failed', 'unknown'].includes(String(value.status))
    && ['sentAt', 'error'].every(key => value[key] === undefined || typeof value[key] === 'string')
    && (value.retryable === undefined || typeof value.retryable === 'boolean')
    && (value.rowCount === undefined || Number.isSafeInteger(value.rowCount) && Number(value.rowCount) >= 0);
}
function snapshot(value: ApiRecord): value is ApiRecord & MarketingReportSettingsSnapshot {
  return isRecord(value.settings) && typeof value.settings.enabled === 'boolean' && typeof value.settings.recipient === 'string' && Number.isSafeInteger(value.settings.version)
    && isRecord(value.schedule) && value.schedule.day === 'Friday' && value.schedule.time === '08:00' && value.schedule.timeZone === 'America/New_York'
    && typeof value.environment === 'string' && Array.isArray(value.recentRuns) && value.recentRuns.every(run);
}

export async function loadMarketingReports(): Promise<MarketingReportSettingsSnapshot> {
  return unwrap(await client.queries.marketingReportSettings().catch(privateApiError), snapshot);
}

export async function saveMarketingReports(settings: MarketingReportSettings): Promise<MarketingReportSettingsSnapshot> {
  return unwrap(await client.mutations.marketingReportAction({ operation: "save", input: JSON.stringify(settings) }).catch(privateApiError), snapshot);
}

export async function sendMarketingReport(requestId: string): Promise<{ run: MarketingReportRun }> {
  return unwrap(await client.mutations.marketingReportAction({ operation: "sendNow", input: JSON.stringify({ requestId }) }).catch(privateApiError),
    (value): value is ApiRecord & { run: MarketingReportRun } => run(value.run));
}
