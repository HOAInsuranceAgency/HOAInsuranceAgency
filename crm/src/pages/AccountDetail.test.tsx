import { describe, expect, it, vi } from "vitest";

vi.mock("aws-amplify/data", () => ({
  generateClient: () => ({ models: {} }),
}));

import { resolveTab, tabsFor } from "./AccountDetail";

/**
 * Which tabs an account offers, and what happens when a URL asks for one it
 * does not.
 *
 * W3's Prior coverage tab is the first lead-only tab in the app, and the rule
 * has an edge that is easy to get wrong: `?tab=` is read before the account
 * has loaded, so the stage cannot be consulted at the moment the initial tab
 * is chosen. A bookmarked `?tab=priorcarrier` on an account that has since
 * converted must not leave the user on a panel with no button to leave it by.
 */
describe("tabsFor", () => {
  it("offers Prior coverage to a lead, and no Policies or Invoices", () => {
    expect(tabsFor("LEAD").map(([t]) => t)).toEqual([
      "overview",
      "priorcarrier",
      "losses",
      "quotes",
      "documents",
      "certificates",
      "activity",
    ]);
  });

  it("gives a client Policies and Invoices, and not Prior coverage", () => {
    expect(tabsFor("CLIENT").map(([t]) => t)).toEqual([
      "overview",
      "losses",
      "quotes",
      "policies",
      "invoices",
      "documents",
      "certificates",
      "activity",
    ]);
  });

  it("keeps Invoices next to Policies", () => {
    // Adjacent on purpose: an invoice bills a policy, and the two questions
    // ("what are they insured for", "what do they owe") are asked together.
    const client = tabsFor("CLIENT").map(([t]) => t);
    expect(client.indexOf("invoices")).toBe(client.indexOf("policies") + 1);
  });

  it("withholds Policies and Invoices from a lead", () => {
    // A policy exists because a quote bound, and binding is what makes the
    // account a client — so on a lead the panel could only ever say "none",
    // which reads as missing data rather than impossible data.
    const lead = tabsFor("LEAD").map(([t]) => t);
    expect(lead).not.toContain("policies");
    expect(lead).not.toContain("invoices");
  });

  it("treats an account with no stage as a lead", () => {
    // Only CLIENT hides it. Anything else — a stage that failed to load, a
    // value from a future migration — errs toward showing the data rather
    // than hiding it, because hiding it looks like the account has none.
    expect(tabsFor(null).map(([t]) => t)).toContain("priorcarrier");
    expect(tabsFor(undefined).map(([t]) => t)).toContain("priorcarrier");
    // The same fallback hides billing, which is the safe direction: an
    // unreadable stage must not offer to bill someone who has bought nothing.
    expect(tabsFor(null).map(([t]) => t)).not.toContain("invoices");
  });
});

describe("resolveTab", () => {
  it("falls a client back to Overview rather than an unreachable tab", () => {
    expect(resolveTab("priorcarrier", "CLIENT")).toBe("overview");
  });

  it("leaves a lead on the tab it asked for", () => {
    expect(resolveTab("priorcarrier", "LEAD")).toBe("priorcarrier");
  });

  it("falls a lead back from Policies and Invoices", () => {
    // The mirror of the Prior coverage case, and the reason the rule had to
    // stop being one-directional: a bookmarked ?tab=policies on a lead used
    // to render a panel the tab bar had no button for.
    expect(resolveTab("policies", "LEAD")).toBe("overview");
    expect(resolveTab("invoices", "LEAD")).toBe("overview");
    expect(resolveTab("invoices", null)).toBe("overview");
  });

  it("leaves a client on them", () => {
    expect(resolveTab("policies", "CLIENT")).toBe("policies");
    expect(resolveTab("invoices", "CLIENT")).toBe("invoices");
  });

  it("keeps Losses for a client — loss history follows the account", () => {
    // The difference between this tab and Prior coverage: a bound policy
    // answers "what is this insured under" better than a prior-carrier row,
    // but nothing supersedes a loss that happened.
    expect(tabsFor("CLIENT").map(([t]) => t)).toContain("losses");
    expect(resolveTab("losses", "CLIENT")).toBe("losses");
  });

  it("touches nothing else, for either stage", () => {
    for (const stage of ["LEAD", "CLIENT"]) {
      for (const t of [
        "overview",
        "losses",
        "quotes",
        "documents",
        "certificates",
        "activity",
      ] as const) {
        expect(resolveTab(t, stage)).toBe(t);
      }
    }
  });

  it("only ever resolves to a tab that account actually offers", () => {
    // The invariant that matters: whatever comes out is something the tab bar
    // will render a button for.
    for (const stage of ["LEAD", "CLIENT", null]) {
      const offered = tabsFor(stage).map(([t]) => t);
      for (const [t] of tabsFor("LEAD")) {
        expect(offered).toContain(resolveTab(t, stage));
      }
    }
  });
});

/**
 * The tab in the URL.
 *
 * `?tab=` was read on mount and never written, so the address bar kept
 * whatever the page was opened with however far the user then navigated:
 * every link copied out of it pointed at the wrong panel, and a refresh landed
 * somewhere other than where the reader was.
 *
 * Asserted against the source rather than through a render, the way
 * `formFiller.test.ts` asserts the shared field cap. Rendering this component
 * means a router, a profile, an account read and all eight tab panels — a lot
 * of scaffolding to observe one search param, and none of it would catch the
 * failure this actually guards: a *second* way to change tabs that forgets to
 * write the URL.
 */
describe("the tab in the URL", () => {
  it("is written by every path that changes the tab", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(
      resolve(process.cwd(), "src/pages/AccountDetail.tsx"),
      "utf8"
    );

    // One writer, and it does write.
    expect(src).toMatch(/function selectTab\(/);
    expect(src).toMatch(/setSearchParams\(/);
    // `setTab` is the raw state setter behind it; a call site that reaches for
    // it directly is a tab change the URL never hears about.
    const rawSetterCalls = src.match(/(?<!function )\bsetTab\(/g) ?? [];
    expect(
      rawSetterCalls.length,
      "setTab is called outside selectTab — that path leaves the URL stale"
    ).toBe(1);
  });
});
