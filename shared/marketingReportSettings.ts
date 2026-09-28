/** Public contract for the administrator's weekly marketing report controls. */
export interface MarketingReportSettings {
  version: number;
  enabled: boolean;
  recipient: string;
}

export interface MarketingReportRun {
  id: string;
  kind: "scheduled" | "manual";
  status: "queued" | "sending" | "sent" | "failed" | "unknown";
  recipient: string;
  asOf: string;
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
  rowCount?: number;
  error?: string;
  retryable?: boolean;
}

export interface MarketingReportSettingsSnapshot {
  settings: MarketingReportSettings;
  schedule: { day: "Friday"; time: "08:00"; timeZone: "America/New_York" };
  environment: string;
  recentRuns: MarketingReportRun[];
}
