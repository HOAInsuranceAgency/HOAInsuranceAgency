/**
 * The dashboard's tab strip, as data.
 *
 * Same architecture as AccountDetail's tabsFor/resolveTab, minus the gating:
 * every tab here exists for every user at every stage, so resolution is only
 * "is this a tab at all". A bookmarked `?tab=` that no longer names one lands
 * on Overview rather than a blank pane with no button to leave it by.
 */
export type DashboardTab =
  | "overview"
  | "leads"
  | "finance"
  | "renewals"
  | "reporting";

/** Display order — this array IS the tab bar. */
export const DASHBOARD_TABS: readonly [DashboardTab, string][] = [
  ["overview", "Overview"],
  ["leads", "Leads"],
  ["finance", "Finance"],
  ["renewals", "Renewals"],
  ["reporting", "Reporting"],
];

export function resolveDashboardTab(
  requested: string | null | undefined
): DashboardTab {
  return DASHBOARD_TABS.some(([t]) => t === requested)
    ? (requested as DashboardTab)
    : "overview";
}
