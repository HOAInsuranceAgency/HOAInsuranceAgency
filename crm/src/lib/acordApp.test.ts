import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

// acordApp reaches ./client for its `Account` type only, but the module graph
// still loads it, and client.ts calls generateClient() at module scope.
vi.mock("aws-amplify/data", () => ({
  generateClient: () => ({ models: {} }),
}));

import {
  LOB_FIELDS,
  PRIOR_COVERAGE_LINE_ROWS,
  legalEntityFor,
  newestPriorByLine,
  priorCoverageBlocks,
} from "./acordApp";
import { LINES_OF_BUSINESS } from "./client";
import { ACORD125_LEGAL_ENTITY_FIELDS, LEGAL_ENTITY_OPTIONS } from "./enums";

/**
 * The ACORD 125's Legal Entity box.
 *
 * Worth its own test because W2 replaced a hardcoded checkbox with a table
 * lookup, and the failure mode is invisible from inside the app: a box that
 * silently stops being ticked on a PDF that goes to a carrier. Nothing in the
 * CRM's own screens would look any different.
 */
describe("legalEntityFor", () => {
  it("keeps ticking Not For Profit for an association that predates the column", () => {
    // Every account in the system is this case on the day W2 ships. Before
    // it, the 125 ticked Not-For-Profit for every ASSOCIATION unconditionally.
    expect(legalEntityFor({ type: "ASSOCIATION" })).toBe("NOT_FOR_PROFIT");
    expect(legalEntityFor({ type: "ASSOCIATION", legalEntityType: null })).toBe(
      "NOT_FOR_PROFIT"
    );
  });

  it("ticks nothing for a non-association that hasn't said", () => {
    // Also the pre-W2 behaviour: the box was only ever ticked for associations.
    expect(legalEntityFor({ type: "PERSONAL" })).toBeNull();
    expect(legalEntityFor({ type: "COMMERCIAL_OTHER" })).toBeNull();
    expect(legalEntityFor({})).toBeNull();
  });

  it("lets a stated type win, including over the association fallback", () => {
    // An HOA that is actually incorporated says so, and the fallback is a
    // stand-in for an unanswered question rather than a fact.
    expect(
      legalEntityFor({ type: "ASSOCIATION", legalEntityType: "CORPORATION" })
    ).toBe("CORPORATION");
    expect(legalEntityFor({ type: "PERSONAL", legalEntityType: "TRUST" })).toBe(
      "TRUST"
    );
  });

  it("only ever returns a member the mapping can tick", () => {
    for (const o of LEGAL_ENTITY_OPTIONS) {
      const picked = legalEntityFor({ legalEntityType: o.value });
      expect(picked).toBe(o.value);
      expect(ACORD125_LEGAL_ENTITY_FIELDS[picked!]).toBeDefined();
    }
  });
});

/**
 * The ACORD 125's prior-coverage block, which W3 turned from one hardcoded
 * General Liability row fed by five Account columns into one row per line fed
 * by the PriorCarrier table.
 */
describe("newestPriorByLine", () => {
  const row = (
    lineOfBusiness: string | null,
    expirationDate: string | null,
    policyNumber?: string,
    effectiveDate?: string
  ) => ({ lineOfBusiness, expirationDate, policyNumber, effectiveDate });

  it("keeps one row per line — the term the submission is replacing", () => {
    const picked = newestPriorByLine([
      row("General Liability", "2024-06-01", "old"),
      row("General Liability", "2026-06-01", "current"),
      row("Property", "2026-03-01", "prop"),
    ]);
    expect(picked.size).toBe(2);
    expect(picked.get("General Liability")?.policyNumber).toBe("current");
    expect(picked.get("Property")?.policyNumber).toBe("prop");
  });

  it("falls back to the term start when a row has no expiration", () => {
    // A row typed off a declarations page that never stated an end date still
    // knows when it began, and is not therefore the older of the two.
    const picked = newestPriorByLine([
      row("Property", "2024-01-01", "old"),
      row("Property", null, "newer", "2026-01-01"),
    ]);
    expect(picked.get("Property")?.policyNumber).toBe("newer");
  });

  it("prefers any dated row over one with no dates at all", () => {
    const picked = newestPriorByLine([
      row("Property", null, "undated"),
      row("Property", "2020-01-01", "dated"),
    ]);
    expect(picked.get("Property")?.policyNumber).toBe("dated");
  });

  it("drops rows with no line — there is no row on the form for them", () => {
    const picked = newestPriorByLine([row(null, "2026-01-01"), row("", "2026-01-01")]);
    expect(picked.size).toBe(0);
  });
});

describe("priorCoverageBlocks", () => {
  const row = (
    lineOfBusiness: string,
    effectiveDate: string | null,
    policyNumber: string,
    expirationDate: string | null = null
  ) => ({ lineOfBusiness, effectiveDate, expirationDate, policyNumber });

  it("groups by policy year, newest first", () => {
    const blocks = priorCoverageBlocks([
      row("General Liability", "2024-06-01", "gl24"),
      row("General Liability", "2026-06-01", "gl26"),
      row("General Liability", "2025-06-01", "gl25"),
    ]);
    expect(blocks.map((b) => b.year)).toEqual(["2026", "2025", "2024"]);
    expect(blocks[0].generalLiability?.policyNumber).toBe("gl26");
  });

  it("fills GL, property and one catch-all within a year", () => {
    const [block] = priorCoverageBlocks([
      row("General Liability", "2026-01-01", "gl"),
      row("Property", "2026-01-01", "prop"),
      row("D&O", "2026-01-01", "do"),
    ]);
    expect(block.generalLiability?.policyNumber).toBe("gl");
    expect(block.property?.policyNumber).toBe("prop");
    // D&O has no row of its own on the form — it takes the OtherLine row.
    expect(block.other?.policyNumber).toBe("do");
  });

  it("drops a second catch-all line rather than overwriting the first", () => {
    // The form has one OtherLine row per year and nowhere else to put a
    // second. Silently replacing the first would be worse than omitting.
    const [block] = priorCoverageBlocks([
      row("D&O", "2026-01-01", "do"),
      row("Crime/Fidelity", "2026-01-01", "crime"),
    ]);
    expect(block.other?.policyNumber).toBe("do");
  });

  it("stops at three years — the form has three blocks", () => {
    const blocks = priorCoverageBlocks(
      ["2026", "2025", "2024", "2023"].map((y) =>
        row("General Liability", `${y}-01-01`, y)
      )
    );
    expect(blocks).toHaveLength(3);
    expect(blocks.map((b) => b.year)).toEqual(["2026", "2025", "2024"]);
  });

  it("sorts undated rows last, so they only take a spare block", () => {
    const blocks = priorCoverageBlocks([
      row("General Liability", null, "undated"),
      row("General Liability", "2026-01-01", "dated"),
    ]);
    expect(blocks.map((b) => b.year)).toEqual(["2026", ""]);
  });

  it("takes the expiration year when there is no term start", () => {
    const [block] = priorCoverageBlocks([
      row("Property", null, "prop", "2026-04-01"),
    ]);
    expect(block.year).toBe("2026");
  });
});

/**
 * The field inventory as a live guard.
 *
 * `docs/acord/acord-125-fields.txt` is the field list read off the agency's
 * own template. Before it existed, six prior-coverage prefixes and four
 * line-of-business boxes were invented, and the only way to find out was to
 * generate a form and read the "Unmatched fields" note. This asserts every
 * name the 125 mapping can emit against it, so an invented one fails here
 * instead.
 *
 * Scoped to the shared header and the 125 branch. The 140 branch names fields
 * on a different template whose inventory has not been read — those are still
 * unverified, and this test is careful not to imply otherwise.
 */
describe("every ACORD 125 field name exists on the template", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

  const inventory = new Set(
    read("../docs/acord/acord-125-fields.txt")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => l.split("  (")[0])
  );

  /** Source down to the 140 branch: the shared header plus the 125 block. */
  const region = (() => {
    const src = read("src/lib/acordApp.ts");
    const cut = src.indexOf('if (formKey === "acord140")');
    expect(cut, "the acord140 branch marker moved").toBeGreaterThan(0);
    return src.slice(0, cut);
  })();

  it("has an inventory to check against", () => {
    // Guards against the vacuous pass PATTERNS records: an empty or moved
    // file would make every assertion below trivially true.
    expect(inventory.size).toBeGreaterThan(400);
    expect(inventory.has("NamedInsured_FullName_A")).toBe(true);
  });

  it("names no field the template does not have", () => {
    const literals = new Set(
      [...region.matchAll(/"([A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+_[A-Z])"/g)].map(
        (m) => m[1]
      )
    );
    expect(literals.size).toBeGreaterThan(20);
    expect([...literals].filter((f) => !inventory.has(f))).toEqual([]);
  });

  it("names no row-suffixed field the template does not have, A through D", () => {
    // The premises block builds names by interpolation, so the literals above
    // never see them.
    for (const [, prefix] of region.matchAll(
      /`([A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+_)\$\{row\}`/g
    )) {
      for (const row of ["A", "B", "C", "D"]) {
        expect(inventory.has(`${prefix}${row}`), `${prefix}${row}`).toBe(true);
      }
    }
  });

  it("covers the prior-coverage grid it can emit — three blocks, four rows", () => {
    for (const block of ["A", "B", "C"]) {
      expect(inventory.has(`PriorCoverage_PolicyYear_${block}`)).toBe(true);
      for (const token of [...Object.values(PRIOR_COVERAGE_LINE_ROWS), "OtherLine"]) {
        for (const suffix of [
          "InsurerFullName",
          "PolicyNumberIdentifier",
          "TotalPremiumAmount",
          "EffectiveDate",
          "ExpirationDate",
        ]) {
          const field = `PriorCoverage_${token}_${suffix}_${block}`;
          expect(inventory.has(field), field).toBe(true);
        }
      }
    }
  });

  it("covers the six Other line-of-business rows", () => {
    for (const row of ["A", "B", "C", "D", "E", "F"]) {
      expect(inventory.has(`Policy_LineOfBusiness_OtherIndicator_${row}`)).toBe(true);
      expect(
        inventory.has(`Policy_LineOfBusiness_OtherLineOfBusinessDescription_${row}`)
      ).toBe(true);
    }
  });

  it("covers the legal-entity boxes, which live in enums.ts", () => {
    // Not caught by the source scan above: the table is in enums.ts, so the
    // 125 mapping emits a name this file never spells. Seven of these eight
    // were derived guesses when W2 shipped.
    for (const [member, candidates] of Object.entries(
      ACORD125_LEGAL_ENTITY_FIELDS
    )) {
      expect(candidates.length, `${member} has no candidates`).toBeGreaterThan(0);
      for (const c of candidates) expect(inventory.has(c), `${member}: ${c}`).toBe(true);
    }
  });

  it("keeps LOB_FIELDS to lines that really have a box", () => {
    for (const [line, candidates] of Object.entries(LOB_FIELDS)) {
      expect(LINES_OF_BUSINESS, `${line} is not a line of business`).toContain(line);
      for (const c of candidates) expect(inventory.has(c), `${line}: ${c}`).toBe(true);
    }
    // The four the form has no box for must stay out, or they are neither
    // ticked nor written into an Other row.
    for (const absent of ["Workers Comp", "Flood", "Earthquake", "D&O"]) {
      expect(LOB_FIELDS[absent], `${absent} has no box on this form`).toBeUndefined();
    }
  });
});
