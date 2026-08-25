import { describe, expect, it } from "vitest";
import { DASHBOARD_TABS, resolveDashboardTab } from "./tabs";

describe("resolveDashboardTab", () => {
  it("accepts every tab the strip renders", () => {
    for (const [t] of DASHBOARD_TABS) expect(resolveDashboardTab(t)).toBe(t);
  });

  it("anything else lands on Overview, never on a pane with no button", () => {
    expect(resolveDashboardTab(null)).toBe("overview");
    expect(resolveDashboardTab(undefined)).toBe("overview");
    expect(resolveDashboardTab("")).toBe("overview");
    expect(resolveDashboardTab("finance ")).toBe("overview");
    expect(resolveDashboardTab("tasks")).toBe("overview");
  });
});
