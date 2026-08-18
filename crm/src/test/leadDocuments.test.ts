import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PORTAL_MAX_FILES,
  PORTAL_TTL_DAYS,
  REQUESTED_DOCUMENTS,
  categoryForKey,
  requestedDocument,
} from "../../../shared/leadDocuments";
import {
  PORTAL_REFUSAL_MESSAGE,
  buildChecklist,
  looksLikeToken,
  refusalFor,
} from "../../amplify/functions/upload-portal/portal";
import { MAX_FILES } from "../../../shared/leadUpload";
import { isExtractableCategory } from "../lib/enums";

/**
 * The document portal's rules.
 *
 * `shared/leadDocuments.ts` names `DocumentCategory` members as bare strings,
 * because `shared/` cannot import the Amplify schema without dragging the
 * browser data client into every Lambda that reads it. That coupling is checked
 * here against `resource.ts`'s own source rather than trusted.
 */

// Read through a helper, matching webLeadFields.test.ts. Inlining
// `new URL(..., import.meta.url)` at module top level fails under the jsdom
// environment with "The URL must be of scheme file" — Vite rewrites a bare
// top-level `import.meta.url` against the jsdom location, which is http:.
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

const SCHEMA = read("../../amplify/data/resource.ts");

/** The members of the `DocumentCategory` enum, off the schema itself. */
function schemaCategories(): string[] {
  const block = SCHEMA.match(/DocumentCategory: a\.enum\(\[([\s\S]*?)\]\)/)?.[1];
  if (!block) throw new Error("DocumentCategory not found in resource.ts");
  return [...block.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
}

describe("the requested-document list", () => {
  it("names only categories the schema declares", () => {
    const declared = schemaCategories();
    // Guards the regex: a reformat that matched nothing would pass vacuously.
    expect(declared.length).toBeGreaterThan(8);
    for (const doc of REQUESTED_DOCUMENTS) {
      expect(declared, `${doc.key} -> ${doc.category}`).toContain(doc.category);
    }
  });

  it("gives every section its own category", () => {
    // buildChecklist counts by category, so two sections sharing one would both
    // report every file sent to either.
    const categories = REQUESTED_DOCUMENTS.map((d) => d.category);
    expect(new Set(categories).size).toBe(categories.length);
  });

  it("has unique keys, since they are the upload mutation's argument", () => {
    const keys = REQUESTED_DOCUMENTS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("asks for all seven things", () => {
    expect(REQUESTED_DOCUMENTS).toHaveLength(7);
    // The two that had no home before this feature.
    const categories = REQUESTED_DOCUMENTS.map((d) => d.category);
    expect(categories).toContain("STATEMENT_OF_VALUES");
    expect(categories).toContain("PROPERTY_UPDATES");
  });

  it("resolves a key to its category, and refuses one it never asked for", () => {
    expect(categoryForKey("loss-runs")).toBe("LOSS_RUNS");
    expect(requestedDocument("loss-runs")?.label).toBe("Loss runs");
    // A public mutation must not file an invented key as OTHER.
    for (const bad of ["", "OTHER", "LOSS_RUNS", "../../etc", null, 7, {}]) {
      expect(categoryForKey(bad)).toBeNull();
    }
  });

  it("keeps every section's help text readable by a trustee", () => {
    for (const doc of REQUESTED_DOCUMENTS) {
      expect(doc.help.length).toBeGreaterThan(20);
      // No em dashes anywhere a lead reads, same rule as the email.
      expect(doc.help).not.toMatch(/[—–]/);
      expect(doc.label).not.toMatch(/[—–]/);
    }
  });

  it("allows far more files than the post-submit panel", () => {
    // Five years of loss runs across three lines is 15 files before anything
    // else on the list; the panel's 10 was never going to cover this.
    expect(PORTAL_MAX_FILES).toBeGreaterThan(MAX_FILES);
    expect(PORTAL_MAX_FILES).toBeGreaterThanOrEqual(20);
  });

  it("stays live long enough for a board that meets monthly", () => {
    expect(PORTAL_TTL_DAYS).toBeGreaterThanOrEqual(30);
  });
});

describe("which documents extraction reads", () => {
  it("reads the ones a datapoint comes off", () => {
    for (const c of [
      "PRIOR_POLICY",
      "LOSS_RUNS",
      "STATEMENT_OF_VALUES",
      "QUOTE_DOC",
      "POLICY_DOC",
    ]) {
      expect(isExtractableCategory(c), c).toBe(true);
    }
  });

  it("skips the ones that would eat the character budget for nothing", () => {
    // A hundred-page master deed sorted above the declaration page is exactly
    // the failure this prevents, and truncation is silent.
    for (const c of ["CONDO_DOCS", "BUDGET", "LICENSE", "ACORD_FORM"]) {
      expect(isExtractableCategory(c), c).toBe(false);
    }
  });

  it("still reads an uncategorised document", () => {
    // OTHER is where the post-submit panel's files land before anyone looks.
    // Excluding it would break the case this pipeline was built for.
    expect(isExtractableCategory("OTHER")).toBe(true);
    expect(isExtractableCategory(null)).toBe(true);
    expect(isExtractableCategory(undefined)).toBe(true);
    expect(isExtractableCategory("NOT_A_REAL_CATEGORY")).toBe(true);
  });

  it("reads at least one category the portal asks for", () => {
    // Otherwise the portal would collect documents nothing ever reads.
    const read = REQUESTED_DOCUMENTS.filter((d) =>
      isExtractableCategory(d.category)
    );
    expect(read.length).toBeGreaterThan(0);
  });
});

describe("what a portal token may do", () => {
  const live = {
    expiresAt: "2026-12-01T00:00:00.000Z",
    revokedAt: null,
    uploadCount: 3,
  };
  const now = "2026-08-18T12:00:00.000Z";

  it("lets a live portal through", () => {
    expect(refusalFor(live, now)).toBeNull();
  });

  it("refuses an unknown token", () => {
    expect(refusalFor(null, now)).toBe("unknown");
    expect(refusalFor(undefined, now)).toBe("unknown");
  });

  it("refuses an expired one, and says how to get a new link", () => {
    expect(refusalFor({ ...live, expiresAt: "2026-08-01T00:00:00.000Z" }, now)).toBe(
      "expired"
    );
    expect(PORTAL_REFUSAL_MESSAGE.expired).toMatch(/reply/i);
  });

  it("treats the expiry instant as expired, not live", () => {
    expect(refusalFor({ ...live, expiresAt: now }, now)).toBe("expired");
  });

  it("puts revocation ahead of expiry", () => {
    // A link a producer killed must read as dead, not as "ask for a fresh one".
    const both = { ...live, expiresAt: "2026-01-01T00:00:00.000Z", revokedAt: now };
    expect(refusalFor(both, now)).toBe("revoked");
  });

  it("tells an unknown token and a revoked one apart from nothing", () => {
    // Identical text on purpose: a caller probing tokens must not learn that one
    // of them existed, because that confirms an account worth guessing at.
    expect(PORTAL_REFUSAL_MESSAGE.revoked).toBe(PORTAL_REFUSAL_MESSAGE.unknown);
  });

  it("refuses once the file ceiling is reached", () => {
    expect(refusalFor({ ...live, uploadCount: PORTAL_MAX_FILES }, now)).toBe("full");
    expect(refusalFor({ ...live, uploadCount: PORTAL_MAX_FILES + 5 }, now)).toBe(
      "full"
    );
    expect(refusalFor({ ...live, uploadCount: PORTAL_MAX_FILES - 1 }, now)).toBeNull();
  });

  it("treats a missing count as zero rather than as full", () => {
    expect(refusalFor({ expiresAt: live.expiresAt, uploadCount: null }, now)).toBeNull();
  });

  it("refuses obvious junk before it becomes a database read", () => {
    for (const bad of ["", "short", "x".repeat(31), null, undefined, 12345, {}]) {
      expect(looksLikeToken(bad)).toBe(false);
    }
    expect(looksLikeToken("a".repeat(32))).toBe(true);
  });
});

describe("the checklist the page renders", () => {
  it("returns every section, in the order asked for", () => {
    const sections = buildChecklist([]);
    expect(sections.map((s) => s.key)).toEqual(
      REQUESTED_DOCUMENTS.map((d) => d.key)
    );
    expect(sections.every((s) => s.received === 0)).toBe(true);
  });

  it("counts documents onto the section that asked for them", () => {
    const sections = buildChecklist([
      { category: "LOSS_RUNS" },
      { category: "LOSS_RUNS" },
      { category: "LOSS_RUNS" },
      { category: "BUDGET" },
    ]);
    const by = Object.fromEntries(sections.map((s) => [s.key, s.received]));
    expect(by["loss-runs"]).toBe(3);
    expect(by.budget).toBe(1);
    expect(by.policies).toBe(0);
  });

  it("ignores documents that answer no question on the list", () => {
    // A staff upload, or the post-submit panel's uncategorised files. The
    // checklist answers "did you send me the loss runs", not "how many files
    // does this account have".
    const sections = buildChecklist([
      { category: "OTHER" },
      { category: "ACORD_FORM" },
      { category: null },
      { category: undefined },
    ]);
    expect(sections.every((s) => s.received === 0)).toBe(true);
  });

  it("carries the label and help text the page renders", () => {
    const first = buildChecklist([])[0];
    expect(first.label).toBe(REQUESTED_DOCUMENTS[0].label);
    expect(first.help).toBe(REQUESTED_DOCUMENTS[0].help);
  });
});
