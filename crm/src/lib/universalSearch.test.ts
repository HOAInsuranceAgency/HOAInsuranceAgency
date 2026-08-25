import { describe, expect, it } from "vitest";
import {
  buildSearchRows,
  ocrSnippet,
  searchRows,
  type SearchIndexInput,
} from "./universalSearch";

const EMPTY: SearchIndexInput = {
  accounts: [],
  contacts: [],
  policies: [],
  invoices: [],
  certificates: [],
  carriers: [],
};

const WORLD: SearchIndexInput = {
  accounts: [
    {
      id: "a1",
      name: "Harbor Pointe COA",
      legalName: "Harbor Pointe Condominium Association, Inc.",
      city: "Boston",
      state: "MA",
      stage: "CLIENT",
    },
    { id: "a2", name: "New Harbor HOA", city: "Salem", state: "MA", stage: "LEAD" },
  ],
  contacts: [
    { id: "ct1", accountId: "a1", name: "Dana Reyes", email: "dana@harborpointe.org" },
  ],
  policies: [
    { id: "p1", accountId: "a1", policyNumber: "WC-2026-000841", carrierId: "car1", status: "ACTIVE" },
    { id: "p2", accountId: "a1", policyNumber: null }, // no handle — unfindable by text, stays out
  ],
  invoices: [
    { id: "i1", accountId: "a1", number: "INV-2026-00012", status: "SENT" },
    { id: "i2", accountId: "a1", number: null },
  ],
  certificates: [
    { id: "cert1", accountId: "a1", certificateNumber: "HOA-2026-00011", holderName: "First Bank of Salem" },
    { id: "cert2", accountId: "a1", certificateNumber: null, holderName: "Harbor Marina LLC" },
  ],
  carriers: [{ id: "car1", name: "Greyhawk Specialty", naicCode: "12345" }],
};

describe("buildSearchRows", () => {
  const rows = buildSearchRows(WORLD);
  const byId = (id: string) => rows.find((r) => r.id === id)!;

  it("joins account and carrier names into the context line", () => {
    expect(byId("p1")).toMatchObject({
      label: "WC-2026-000841",
      sub: "Harbor Pointe COA · Greyhawk Specialty · Active",
      target: "/accounts/a1?tab=policies",
    });
    expect(byId("ct1").sub).toBe("dana@harborpointe.org · Harbor Pointe COA");
  });

  it("rows without a human handle stay out rather than matching nothing", () => {
    expect(rows.find((r) => r.id === "p2")).toBeUndefined();
    expect(rows.find((r) => r.id === "i2")).toBeUndefined();
  });

  it("a certificate without a number is findable by its holder", () => {
    expect(byId("cert2")).toMatchObject({ label: "Harbor Marina LLC" });
  });

  it("indexes no PII or write-only fields — fein and buildiumId never match", () => {
    const all = buildSearchRows({
      ...EMPTY,
      accounts: [
        {
          id: "a9",
          name: "Plain HOA",
          // Present on the model, deliberately absent from SearchIndexInput's
          // account shape — this test documents the exclusion.
          ...( { fein: "04-1234567", buildiumId: "B-99" } as object),
        },
      ],
    });
    expect(all[0].haystack).toEqual(["plain hoa"]);
  });
});

describe("searchRows", () => {
  const rows = buildSearchRows(WORLD);

  it("needs two characters — one letter matches too much to mean anything", () => {
    expect(searchRows(rows, "h")).toEqual([]);
    expect(searchRows(rows, "  ")).toEqual([]);
  });

  it("prefix beats word-prefix beats substring, case-insensitively", () => {
    const groups = searchRows(rows, "har");
    const accounts = groups.find((g) => g.type === "account")!;
    // "Harbor Pointe" starts with it; "New Harbor" contains a word that does.
    expect(accounts.hits.map((h) => h.label)).toEqual([
      "Harbor Pointe COA",
      "New Harbor HOA",
    ]);
  });

  it("groups arrive in fixed order with people before paper", () => {
    const groups = searchRows(rows, "harbor");
    expect(groups.map((g) => g.type)).toEqual([
      "account",
      "contact", // dana@harborpointe.org
      "certificate", // Harbor Marina LLC
    ]);
  });

  it("caps each group and says how many the cap hid", () => {
    const many: SearchIndexInput = {
      ...EMPTY,
      accounts: Array.from({ length: 8 }, (_, i) => ({
        id: `x${i}`,
        name: `Meadow ${i} HOA`,
      })),
    };
    const [group] = searchRows(buildSearchRows(many), "meadow", 5);
    expect(group.hits).toHaveLength(5);
    expect(group.more).toBe(3);
  });

  it("finds paper by its numbers", () => {
    expect(searchRows(rows, "inv-2026")[0].hits[0].label).toBe("INV-2026-00012");
    expect(searchRows(rows, "12345")[0].hits[0].label).toBe("Greyhawk Specialty");
  });

  it("a hyphen starts a word too — 'Harbor-Pointe' ranks with the space-boundary names", () => {
    const world: SearchIndexInput = {
      ...EMPTY,
      accounts: [
        { id: "h1", name: "Harbor-Pointe HOA" },
        { id: "h2", name: "Bay Pointe HOA" },
        { id: "h3", name: "Southpointe Realty" },
      ],
    };
    const [group] = searchRows(buildSearchRows(world), "pointe");
    // Both word-boundary names outrank the bare-substring match.
    expect(group.hits.map((h) => h.label)).toEqual([
      "Bay Pointe HOA",
      "Harbor-Pointe HOA",
      "Southpointe Realty",
    ]);
  });

  it("underscored enum tokens read as words, not identifiers", () => {
    const world: SearchIndexInput = {
      ...EMPTY,
      accounts: [{ id: "a1", name: "Harbor Pointe COA" }],
      policies: [
        { id: "p1", accountId: "a1", policyNumber: "OLD-001", status: "NON_RENEWED" },
      ],
    };
    const [group] = searchRows(buildSearchRows(world), "old-001");
    expect(group.hits[0].sub).toBe("Harbor Pointe COA · Non renewed");
  });
});

describe("ocrSnippet", () => {
  const text = `${"a".repeat(100)} the deductible is five thousand dollars ${"z".repeat(100)}`;

  it("cuts a ±60-character window with ellipses where text continues", () => {
    const snip = ocrSnippet(text, "Deductible")!;
    expect(snip.startsWith("…")).toBe(true);
    expect(snip.endsWith("…")).toBe(true);
    expect(snip).toContain("deductible is five thousand");
  });

  it("is null when only the file name matched, or there is no text", () => {
    expect(ocrSnippet(text, "premium")).toBeNull();
    expect(ocrSnippet(null, "deductible")).toBeNull();
  });
});
