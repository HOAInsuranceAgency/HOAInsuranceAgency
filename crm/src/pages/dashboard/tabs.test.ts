import { describe, expect, it } from "vitest";
import { DASHBOARD_TABS, resolveDashboardTab } from "./tabs";

describe("resolveDashboardTab", () => {
  it("accepts every tab the strip renders", () => {
    for (const [t] of DASHBOARD_TABS) expect(resolveDashboardTab(t)).toBe(t);
  });

  it("retired and unknown bookmarks land on Dashboard", () => {
    expect(resolveDashboardTab(null)).toBe("dashboard");
    expect(resolveDashboardTab(undefined)).toBe("dashboard");
    expect(resolveDashboardTab("")).toBe("dashboard");
    expect(resolveDashboardTab("finance ")).toBe("dashboard");
    expect(resolveDashboardTab("tasks")).toBe("dashboard");
    for (const tab of ['overview', 'reporting', 'renewals']) expect(resolveDashboardTab(tab)).toBe('dashboard');
    expect(DASHBOARD_TABS.map(([, label]) => label)).toEqual(['Dashboard', 'Leads', 'Finance']);
  });
});
