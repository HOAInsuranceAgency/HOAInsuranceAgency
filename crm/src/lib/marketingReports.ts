import { client } from "./client";
import { isAuthorizationError } from "../../../shared/authorizationError";
import type { MarketingReportRun, MarketingReportSettings, MarketingReportSettingsSnapshot } from "../../../shared/marketingReportSettings";

function unwrap<T>(response: { data?: unknown; errors?: readonly { message: string }[] }): T {
  if (response.errors?.length) {
    const denied = response.errors.find(isAuthorizationError);
    throw Object.assign(new Error((denied ?? response.errors[0]).message), denied ? { name: "Unauthorized" } : {});
  }
  const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data;
  if (!data || typeof data !== "object" || !(data as { ok?: boolean }).ok) {
    const message = (data as { error?: string } | null)?.error ?? "The marketing report request could not be completed.";
    throw Object.assign(new Error(message),
      isAuthorizationError(data) || isAuthorizationError(message) || message === "Administrator access is required." ? { name: "Unauthorized" } : {});
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
