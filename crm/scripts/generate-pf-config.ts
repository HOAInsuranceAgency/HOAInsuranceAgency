/**
 * config/premium_finance/jurisdictions.yml → src/lib/premiumFinance/jurisdictions.ts
 *
 * The YAML is the signed-off compliance artifact; this emits the form the
 * bundlers can actually ship. Amplify's esbuild step bundles TypeScript, not
 * arbitrary assets (the invoice logo is fetched at runtime for exactly this
 * reason), so a YAML file cannot reach a Lambda — a generated TS module can,
 * and the SPA imports the same one, so the gate the browser renders and the
 * gate the server enforces cannot disagree.
 *
 * Drift is guarded twice: `jurisdictions.test.ts` re-parses the YAML with
 * js-yaml and asserts deep equality with this module's exports, and the module
 * carries a SHA-256 of the YAML bytes, shown on the admin screen — so
 * production can be checked against the signed file by eye, without a diff.
 *
 * Run with: npm run pf:generate
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";

const ROOT = resolve(process.cwd());
const YAML_PATH = resolve(ROOT, "config/premium_finance/jurisdictions.yml");
const OUT_PATH = resolve(ROOT, "src/lib/premiumFinance/jurisdictions.ts");

/**
 * USPS codes are reference data, not compliance data, so they live in the
 * generator rather than the signed file. `Account.state` in this codebase is
 * the two-letter form (ACORD state fields require it); the YAML uses the full
 * names the source table was signed with. The drift test asserts the mapping
 * is total and unique over the 51 rows.
 */
const USPS: Record<string, string> = {
  Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA",
  Colorado: "CO", Connecticut: "CT", Delaware: "DE",
  "District of Columbia": "DC", Florida: "FL", Georgia: "GA", Hawaii: "HI",
  Idaho: "ID", Illinois: "IL", Indiana: "IN", Iowa: "IA", Kansas: "KS",
  Kentucky: "KY", Louisiana: "LA", Maine: "ME", Maryland: "MD",
  Massachusetts: "MA", Michigan: "MI", Minnesota: "MN", Mississippi: "MS",
  Missouri: "MO", Montana: "MT", Nebraska: "NE", Nevada: "NV",
  "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM",
  "New York": "NY", "North Carolina": "NC", "North Dakota": "ND", Ohio: "OH",
  Oklahoma: "OK", Oregon: "OR", Pennsylvania: "PA", "Rhode Island": "RI",
  "South Carolina": "SC", "South Dakota": "SD", Tennessee: "TN", Texas: "TX",
  Utah: "UT", Vermont: "VT", Virginia: "VA", Washington: "WA",
  "West Virginia": "WV", Wisconsin: "WI", Wyoming: "WY",
};

interface YamlRow {
  name: string;
  status: "open" | "conditional" | "closed";
  max_apr: number | null;
  /** Boolean on open/conditional rows; null on closed rows — enforced below. */
  max_apr_verified: boolean | null;
  min_principal: number | null;
  note: string;
}
interface YamlDoc {
  jurisdictions: YamlRow[];
  coverage_lines: { allow: string[]; deny: string[] };
}

const raw = readFileSync(YAML_PATH, "utf8");
const sha256 = createHash("sha256").update(raw).digest("hex");
const doc = load(raw) as YamlDoc;

/** Refuse to emit from a malformed file — a partial table is a wrong gate. */
const STATUSES = new Set(["open", "conditional", "closed"]);
if (!Array.isArray(doc?.jurisdictions) || doc.jurisdictions.length !== 51) {
  throw new Error(`expected 51 jurisdictions, found ${doc?.jurisdictions?.length}`);
}
for (const j of doc.jurisdictions) {
  if (!j.name || !USPS[j.name]) throw new Error(`no USPS code for "${j.name}"`);
  if (!STATUSES.has(j.status)) throw new Error(`${j.name}: bad status "${j.status}"`);
  /**
   * The verified flag is required on any row that could lend and forbidden on
   * one that cannot. Both directions are the point: a closed row carrying
   * `true` would let a future closed→open upgrade skip re-verifying the
   * ceiling, and an open row without the flag has not answered the question
   * the flag exists to ask. (Decision amendment, 2026-08-21.)
   */
  if (j.status === "closed") {
    if (j.max_apr_verified !== null) {
      throw new Error(
        `${j.name}: closed rows must carry max_apr_verified: null — a verified value on a closed row asserts a check nobody made`
      );
    }
  } else if (typeof j.max_apr_verified !== "boolean") {
    throw new Error(
      `${j.name}: ${j.status} rows must state max_apr_verified explicitly`
    );
  }
  if (j.max_apr !== null && typeof j.max_apr !== "number") {
    throw new Error(`${j.name}: max_apr must be number|null`);
  }
  if (j.min_principal !== null && typeof j.min_principal !== "number") {
    throw new Error(`${j.name}: min_principal must be number|null`);
  }
  if (typeof j.note !== "string" || !j.note) throw new Error(`${j.name}: missing note`);
}
if (!doc.coverage_lines?.allow?.length || !doc.coverage_lines?.deny?.length) {
  throw new Error("coverage_lines.allow/deny missing or empty");
}
const floodOnAList = [...doc.coverage_lines.allow, ...doc.coverage_lines.deny].some(
  (l) => /flood/i.test(l)
);
if (floodOnAList) {
  // The signed decision: flood resolves in logic, never by list membership.
  throw new Error("flood must not appear on either coverage list — see the spec");
}

const rows = doc.jurisdictions.map((j) => ({
  name: j.name,
  code: USPS[j.name],
  status: j.status,
  maxApr: j.max_apr,
  maxAprVerified: j.max_apr_verified,
  minPrincipal: j.min_principal,
  note: j.note,
}));

const out = `/**
 * GENERATED FILE — do not edit.
 *
 * Source of truth: config/premium_finance/jurisdictions.yml (the signed-off
 * compliance artifact). Regenerate with \`npm run pf:generate\`. The drift test
 * in jurisdictions.test.ts fails if this file and the YAML disagree, and
 * PF_CONFIG_SHA256 below is the hash of the YAML bytes this was built from —
 * displayed on the admin screen so a running deployment can be checked
 * against the signed file at a glance.
 */

export type PfStatus = "open" | "conditional" | "closed";

export interface PfJurisdiction {
  name: string;
  /** Two-letter USPS code — the form Account.state holds. */
  code: string;
  status: PfStatus;
  /** Percent, e.g. 18.0. Null = no statutory cap. */
  maxApr: number | null;
  /**
   * False = the ceiling is unresolved; the jurisdiction behaves as CLOSED.
   * Null = closed row, not applicable — and deliberately so: a closed→open
   * upgrade starts with no verified value, forcing the ceiling to be
   * re-checked before the row can lend.
   */
  maxAprVerified: boolean | null;
  /** Minimum amount financed. Ohio only. */
  minPrincipal: number | null;
  /** Shown to the user when blocked. */
  note: string;
}

/** SHA-256 of the signed YAML this module was generated from. */
export const PF_CONFIG_SHA256 = ${JSON.stringify(sha256)};

export const PF_JURISDICTIONS: readonly PfJurisdiction[] = ${JSON.stringify(rows, null, 2)};

export const PF_COVERAGE_ALLOW: readonly string[] = ${JSON.stringify(doc.coverage_lines.allow, null, 2)};

export const PF_COVERAGE_DENY: readonly string[] = ${JSON.stringify(doc.coverage_lines.deny, null, 2)};
`;

writeFileSync(OUT_PATH, out);
console.log(`wrote ${OUT_PATH} (${rows.length} jurisdictions, sha ${sha256.slice(0, 12)}…)`);
