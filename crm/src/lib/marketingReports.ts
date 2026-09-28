import { client } from "./client";
import type { MarketingReportRun, MarketingReportSettings, MarketingReportSettingsSnapshot } from "../../../shared/marketingReportSettings";

function unwrap<T>(response: { data?: unknown; errors?: readonly { message: string }[] }): T {
  if (response.errors?.length) throw new Error(response.errors[0].message);
  const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data;
  if (!data || typeof data !== "object" || !(data as { ok?: boolean }).ok) {
    throw new Error((data as { error?: string } | null)?.error ?? "The marketing report request could not be completed.");
  }
  return data as T;
}

export async function loadMarketingReports(): Promise<MarketingReportSettingsSnapshot> {
  return unwrap(await client.queries.marketingReportSettings());
}

export async function saveMarketingReports(settings: MarketingReportSettings): Promise<MarketingReportSettingsSnapshot> {
  return unwrap(await client.mutations.marketingReportAction({ operation: "save", input: JSON.stringify(settings) }));
}

export async function sendMarketingReport(requestId: string): Promise<{ run: MarketingReportRun }> {
  return unwrap(await client.mutations.marketingReportAction({ operation: "sendNow", input: JSON.stringify({ requestId }) }));
}
