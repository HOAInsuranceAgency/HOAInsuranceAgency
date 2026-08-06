import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

// acordApp reaches ./client for its `Account` type only, but the module graph
// still loads it, and client.ts calls generateClient() at module scope.
vi.mock("aws-amplify/data", () => ({
  generateClient: () => ({ models: {} }),
}));

import {
  BLANKET_SUMMARY_ROWS,
  BUILDINGS_PER_140,
  BUILDING_BLOCKS,
  GL_CLASS_CODE_ROWS,
  LOB_OTHER_ROWS,
  LOSS_HISTORY_ROWS,
  PREMISES_ROWS,
  PRIOR_COVERAGE_BLOCKS,
  SUBJECT_ROW_RUNS,
  LOB_FIELDS,
  PRIOR_COVERAGE_LINE_ROWS,
  buildingPages,
  legalEntityFor,
  newestPriorByLine,
  operationsSummary,
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
 * Scoped to the shared header and the 125 branch; the 126 and 140 branches
 * have their own inventories and their own blocks of assertions below.
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

  /**
   * Source down to the 126 branch: the shared header plus the 125 block.
   *
   * The cut used to be at the 140 branch, which was right only while the 126
   * branch between them was an empty comment. Once it had field names in it,
   * they were being checked against the 125's inventory — and the first thing
   * that fell out was a real 126 field reported as not existing.
   */
  const region = (() => {
    const src = read("src/lib/acordApp.ts");
    const cut = src.indexOf('if (formKey === "acord126")');
    expect(cut, "the acord126 branch marker moved").toBeGreaterThan(0);
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

  it("names no row-suffixed field the template does not have", () => {
    // Interpolated names — the premises block, the loss rows, the Other
    // line-of-business rows — are invisible to the literal scan above.
    //
    // The row COUNT differs per section (premises has four, loss history
    // three, Other six), so this asserts each prefix's first row exists and
    // that its run is contiguous from A, then the row constants below assert
    // that the code iterates the right number of them. Assuming one count for
    // every section is what failed when the loss rows arrived.
    const prefixes = [
      ...region.matchAll(/`([A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+_)\$\{row\}`/g),
    ].map((m) => m[1]);
    expect(prefixes.length, "no interpolated candidates found").toBeGreaterThan(5);
    for (const prefix of new Set(prefixes)) {
      expect(inventory.has(`${prefix}A`), `${prefix}A`).toBe(true);
    }
  });

  it("iterates the number of rows each section actually has", () => {
    // The constants the loops run over, checked against the form rather than
    // against each other. A section given one row too many writes into a
    // field that does not exist; one too few silently drops a row.
    const runs: [string, readonly string[], string][] = [
      ["premises", PREMISES_ROWS, "CommercialStructure_PhysicalAddress_LineOne_"],
      ["loss history", LOSS_HISTORY_ROWS, "LossHistory_OccurrenceDate_"],
      ["other lines of business", LOB_OTHER_ROWS, "Policy_LineOfBusiness_OtherIndicator_"],
      ["prior coverage", PRIOR_COVERAGE_BLOCKS, "PriorCoverage_PolicyYear_"],
    ];
    for (const [name, rows, prefix] of runs) {
      for (const row of rows) {
        expect(inventory.has(`${prefix}${row}`), `${name}: ${prefix}${row}`).toBe(true);
      }
      // And one past the end must NOT exist, or the constant is short.
      const next = String.fromCharCode(
        rows[rows.length - 1].charCodeAt(0) + 1
      );
      expect(
        inventory.has(`${prefix}${next}`),
        `${name}: the form has a ${prefix}${next} the code never fills`
      ).toBe(false);
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

  it("never ticks 'no prior losses' automatically", () => {
    // The single most consequential assertion this app could make on a
    // carrier submission, and the one a field-name guard cannot catch: the
    // box exists, so emitting it would pass every other check here.
    //
    // The form asks "no prior losses", not "any losses", so the naive reading
    // of an account with no Loss rows is to tick it. An account with no rows
    // far more often means nobody has entered a loss run than that there were
    // none, and this app cannot tell the difference. A producer ticks it.
    expect(inventory.has("LossHistory_NoPriorLossesIndicator_A")).toBe(true);
    // Matched inside a `candidates:` list rather than anywhere in the file:
    // the comment explaining this decision names the field, and a bare
    // substring check fails on the explanation itself.
    const emitted = [
      ...region.matchAll(/candidates:\s*\[([^\]]*)\]/g),
    ].map((m) => m[1]);
    expect(emitted.length).toBeGreaterThan(20);
    expect(
      emitted.filter((c) => c.includes("NoPriorLosses")),
      "the mapping emits the no-prior-losses box"
    ).toEqual([]);
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


describe("buildingPages", () => {
  it("puts two buildings on a PDF, because that is what the form holds", () => {
    const pages = buildingPages([1, 2, 3, 4, 5]);
    expect(BUILDINGS_PER_140).toBe(2);
    expect(pages).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("still produces one page for an account with no buildings", () => {
    // The form still carries the account's address, the blanket summary and
    // the signature block — generating nothing would be worse than a page
    // with the building sections empty.
    expect(buildingPages([])).toEqual([[]]);
  });
});

describe("operationsSummary", () => {
  const b = (stories?: number, constructionType?: string, yearBuilt?: number) => ({
    stories,
    constructionType,
    yearBuilt,
  });

  it("describes the site from the buildings, not from the Account", () => {
    const summary = operationsSummary({ type: "ASSOCIATION", unitCount: 52 }, [
      b(2, "FRAME", 2016),
      b(2, "FRAME", 2016),
      b(2, "FRAME", 2017),
    ]);
    expect(summary).toBe(
      "52-unit residential condominium association consisting of 3 two-story wood-frame buildings constructed 2016."
    );
  });

  it("takes the most common answer, not the first or the oldest", () => {
    // A 1978 clubhouse among twelve 2016 townhouses is a 2016 site with an
    // old clubhouse. "Constructed 1978" would be the wrong headline, and it
    // is what a first-row or a minimum would have produced.
    const summary = operationsSummary(
      { type: "ASSOCIATION", unitCount: 13 },
      [b(1, "JOISTED_MASONRY", 1978), ...Array(12).fill(b(2, "FRAME", 2016))]
    );
    expect(summary).toContain("two-story wood-frame");
    expect(summary).toContain("constructed 2016");
  });

  it("says nothing for a non-association", () => {
    expect(operationsSummary({ type: "PERSONAL", unitCount: 1 }, [b(2)])).toBe("");
  });
});

/**
 * The 126's inventory, guarding its mapping the same way the other two do.
 *
 * The 126 is the form the GL card on the Overview tab was built to feed, and
 * it sat at "Mapping not built yet" while that card collected exactly the
 * fields it wants. Every name in the branch was read off the agency's uploaded
 * template via Settings → Inspect fields; this is what keeps it that way.
 */
describe("every ACORD 126 field name exists on the template", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

  const inventory = new Set(
    read("../docs/acord/acord-126-fields.txt")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => l.split("  (")[0])
  );

  /** Source from the 126 branch to the start of the 140's. */
  const region = (() => {
    const src = read("src/lib/acordApp.ts");
    const from = src.indexOf('if (formKey === "acord126")');
    const to = src.indexOf('if (formKey === "acord140")');
    expect(from, "the acord126 branch marker moved").toBeGreaterThan(0);
    expect(to, "the acord140 branch marker moved").toBeGreaterThan(from);
    return src.slice(from, to);
  })();

  it("has an inventory to check against", () => {
    // Guards the vacuous pass: an empty or moved file makes everything below
    // trivially true.
    expect(inventory.size).toBeGreaterThan(200);
    expect(inventory.has("GeneralLiability_EachOccurrence_LimitAmount_A")).toBe(true);
  });

  it("names no field the template does not have", () => {
    const literals = new Set(
      [...region.matchAll(/"([A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+_[A-Z])"/g)].map(
        (m) => m[1]
      )
    );
    expect(literals.size).toBeGreaterThan(15);
    expect([...literals].filter((f) => !inventory.has(f))).toEqual([]);
  });

  it("names no row-suffixed field the template does not have", () => {
    const prefixes = [
      ...region.matchAll(/`([A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+_)\$\{row\}`/g),
    ].map((m) => m[1]);
    expect(prefixes.length, "no interpolated candidates found").toBeGreaterThan(3);
    for (const prefix of prefixes) {
      for (const row of GL_CLASS_CODE_ROWS) {
        expect(inventory.has(`${prefix}${row}`), `${prefix}${row}`).toBe(true);
      }
    }
  });

  it("iterates exactly the three classification rows the form prints", () => {
    // A fourth row would write into fields that do not exist; two would drop a
    // class code the producer entered.
    expect([...GL_CLASS_CODE_ROWS]).toEqual(["A", "B", "C"]);
    expect(inventory.has("GeneralLiability_Hazard_ClassCode_C")).toBe(true);
    expect(inventory.has("GeneralLiability_Hazard_ClassCode_D")).toBe(false);
  });

  it("maps none of the opaque question codes", () => {
    // `Contractors_Question_<XXX>Code_A` and its GeneralLiabilityLineOfBusiness
    // twin are ACORD question identifiers, and nothing in the field name says
    // which question each asks — AAB sits beside a different explanation field
    // in each family. A Y in the wrong box is a misstatement on a document an
    // underwriter prices from, so these stay unmapped until the codes can be
    // confirmed against the printed form.
    expect(region).not.toMatch(/Question_[A-Z]{3}Code/);
  });
});

/**
 * The 140's inventory, guarding the mapping the same way the 125's does.
 *
 * This form is the one where the suffixes do not line up — the
 * subject-of-insurance rows run _A.._E and _G.._K with no _F, and the premises
 * remark is _A and _C — so an interpolated block letter would produce five
 * names that match nothing. The assertions below are what makes that a build
 * failure rather than five silently empty boxes.
 */
describe("every ACORD 140 field name exists on the template", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

  const inventory = new Set(
    read("../docs/acord/acord-140-fields.txt")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => l.split("  (")[0])
  );

  /** Source from the 140 branch to the end of the mapping function. */
  const region = (() => {
    const src = read("src/lib/acordApp.ts");
    const cut = src.indexOf('if (formKey === "acord140")');
    expect(cut, "the acord140 branch marker moved").toBeGreaterThan(0);
    return src.slice(cut);
  })();

  it("has an inventory to check against", () => {
    expect(inventory.size).toBeGreaterThan(300);
    expect(inventory.has("Construction_ConstructionCode_A")).toBe(true);
    // The quirks this form is guarded for, asserted as facts about the file
    // rather than trusted from a comment.
    expect(inventory.has("CommercialProperty_Premises_LimitAmount_F")).toBe(false);
    expect(inventory.has("CommercialProperty_Premises_LimitAmount_G")).toBe(true);
    expect(inventory.has("CommercialProperty_Premises_RemarkText_C")).toBe(true);
    expect(inventory.has("CommercialProperty_Premises_RemarkText_B")).toBe(false);
  });

  it("names no interpolated field the template does not have", () => {
    // Every candidate in the 140 branch is built from a template literal, so
    // this evaluates them the way the mapping does: over both blocks.
    // The real table, not a copy of it — a copy would keep passing while the
    // mapping used different suffixes, which is precisely the failure this
    // exists to catch.
    const blocks = BUILDING_BLOCKS.map((b) => ({
      F: b.fields,
      S: b.subject,
      R: b.remark,
    }));
    const patterns = [
      ...region.matchAll(/`([A-Za-z][\w]*(?:_[\w]+)*_)\$\{([FSR])\}`/g),
    ];
    expect(patterns.length, "no interpolated candidates found").toBeGreaterThan(20);
    for (const [, prefix, which] of patterns) {
      for (const block of blocks) {
        const field = `${prefix}${block[which as "F" | "S" | "R"]}`;
        expect(inventory.has(field), field).toBe(true);
      }
    }
  });

  it("draws each block's rows from its own run, not from the other's", () => {
    // The assertion a name check cannot make. `subject: "B"` on the second
    // block names CommercialProperty_Premises_*_B, which exists — it is the
    // FIRST block's second row — so the form would come out with two rows of
    // building one's coverage and none of building two's, and every field
    // name in it would be valid.
    expect(BUILDING_BLOCKS.length).toBe(SUBJECT_ROW_RUNS.length);
    BUILDING_BLOCKS.forEach((block, i) => {
      expect(SUBJECT_ROW_RUNS[i], `block ${i} subject row`).toContain(block.subject);
      // And the runs must not overlap, or "its own run" means nothing.
      for (const [j, run] of SUBJECT_ROW_RUNS.entries()) {
        if (j !== i) expect(run).not.toContain(block.subject);
      }
    });
    // Every row of both runs is real, and the gap between them is too.
    for (const run of SUBJECT_ROW_RUNS) {
      for (const row of run) {
        expect(
          inventory.has(`CommercialProperty_Premises_LimitAmount_${row}`),
          row
        ).toBe(true);
      }
    }
  });

  it("covers the improvement pairs, which build their names twice over", () => {
    for (const kind of ["Roofing", "Heating", "Wiring", "Plumbing"]) {
      for (const block of ["A", "B"]) {
        expect(inventory.has(`BuildingImprovement_${kind}Year_${block}`)).toBe(true);
        expect(inventory.has(`BuildingImprovement_${kind}Indicator_${block}`)).toBe(
          true
        );
      }
    }
  });

  it("covers the four blanket summary rows", () => {
    expect([...BLANKET_SUMMARY_ROWS]).toEqual(["A", "B", "C", "D"]);
    for (const row of BLANKET_SUMMARY_ROWS) {
      expect(
        inventory.has(`CommercialProperty_Summary_BlanketNumberIdentifier_${row}`)
      ).toBe(true);
      expect(
        inventory.has(`CommercialProperty_Summary_BlanketLimitAmount_${row}`)
      ).toBe(true);
      expect(
        inventory.has(`CommercialCoverage_Summary_BlanketTypeDescription_${row}`)
      ).toBe(true);
    }
  });
});
