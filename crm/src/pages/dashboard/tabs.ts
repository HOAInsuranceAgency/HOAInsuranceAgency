/** Admin dashboard views. Retired/unknown bookmarks land on Dashboard. */
export type DashboardTab = 'dashboard' | 'leads' | 'finance';
export const DASHBOARD_TABS: readonly [DashboardTab, string][] = [
  ['dashboard', 'Dashboard'],
  ['leads', 'Leads'],
  ['finance', 'Finance'],
];
export function resolveDashboardTab(requested: string | null | undefined): DashboardTab {
  return DASHBOARD_TABS.some(([tab]) => tab === requested) ? requested as DashboardTab : 'dashboard';
}
