import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_OPTIONS,
  ACORD125_LEGAL_ENTITY_FIELDS,
  BUILDING_DEDUCTIBLE_TYPE_LABELS,
  BUILDING_DEDUCTIBLE_TYPE_OPTIONS,
  CAUSE_OF_LOSS_LABELS,
  CAUSE_OF_LOSS_OPTIONS,
  REPLACEMENT_COST_CODES,
  ACORD25_AGGREGATE_FIELDS,
  AGGREGATE_APPLIES_TO_OPTIONS,
  CONSTRUCTION_LABELS,
  CONSTRUCTION_OPTIONS,
  CONSTRUCTION_PHRASES,
  CONSTRUCTION_TYPES,
  CONTACT_TYPE_LABELS,
  CONTACT_TYPE_OPTIONS,
  DEFAULT_ASSOCIATION_LEGAL_ENTITY,
  DEFENSE_LIMIT_POSITION_LABELS,
  DEFENSE_LIMIT_POSITION_OPTIONS,
  DO_COVERAGE_TYPE_LABELS,
  DO_COVERAGE_TYPE_OPTIONS,
  DO_PARTS,
  DO_PART_LABELS,
  GL_DEDUCTIBLE_TYPE_LABELS,
  GL_DEDUCTIBLE_TYPE_OPTIONS,
  GL_PREMIUM_BASIS_LABELS,
  GL_PREMIUM_BASIS_OPTIONS,
  DEFAULT_CONTACT_TYPE,
  DOCUMENT_CATEGORY_EXTRACTION_PRIORITY,
  DOCUMENT_CATEGORY_OPTIONS,
  LEGAL_ENTITY_LABELS,
  LEGAL_ENTITY_OPTIONS,
  LICENSE_CLASS_LABELS,
  LICENSE_RESIDENCY_OPTIONS,
  LICENSE_STATUS_LABELS,
  MANUAL_TASK_RESOLUTIONS,
  POLICY_STATUSES,
  REPLACEMENT_COST_OPTIONS,
  USER_ROLES,
  USER_ROLE_LABELS,
  USER_ROLE_OPTIONS,
  isAccountType,
  type AccountStage,
  type AccountType,
  type AggregateAppliesTo,
  type BuildingDeductibleType,
  type CauseOfLoss,
  type ConstructionType,
  type ContactType,
  type DefenseLimitPosition,
  type DoCoverageType,
  type DoPart,
  type GlDeductibleType,
  type GlPremiumBasis,
  type DocumentCategory,
  type LegalEntityType,
  type LicenseClass,
  type LicenseHolderType,
  type LicenseResidency,
  type LicenseStatus,
  type MarketingTaskResolution,
  type MarketingTaskSource,
  type OcrStatus,
  type PolicyStatus,
  type ReplacementCostType,
  type UserRole,
} from "./enums";

/**
 * The `satisfies Record<TheEnum, …>` guards in enums.ts only bite while the
 * enum types are unions of literals. If a schema or codegen change ever
 * widened one to `string`, every guard would accept anything and go quiet
 * without a single error. One assertion per enum that this file relies on.
 */
type NotWidened<T> = [string] extends [T] ? never : true;
const stillLiteralUnions: [
  NotWidened<AccountStage>,
  NotWidened<AccountType>,
  NotWidened<PolicyStatus>,
  NotWidened<DocumentCategory>,
  NotWidened<OcrStatus>,
  NotWidened<UserRole>,
  NotWidened<MarketingTaskResolution>,
  NotWidened<MarketingTaskSource>,
  NotWidened<LicenseHolderType>,
  NotWidened<LicenseClass>,
  NotWidened<LicenseResidency>,
  NotWidened<LicenseStatus>,
  NotWidened<ConstructionType>,
  NotWidened<ReplacementCostType>,
  NotWidened<AggregateAppliesTo>,
  NotWidened<ContactType>,
  NotWidened<LegalEntityType>,
  NotWidened<GlDeductibleType>,
  NotWidened<GlPremiumBasis>,
  NotWidened<DoPart>,
  NotWidened<DoCoverageType>,
  NotWidened<DefenseLimitPosition>,
  NotWidened<BuildingDeductibleType>,
  NotWidened<CauseOfLoss>,
] = [
  true, true, true, true, true, true, true, true, true, true, true, true, true,
  true, true, true, true, true, true, true, true, true, true, true,
];

/**
 * The enum members as written in the schema, read from source rather than
 * imported: amplify/data/resource.ts pulls in @aws-amplify/backend at runtime,
 * and enums.ts deliberately imports only its *type*. Same approach as
 * quoteStatus.test.ts.
 */
function schemaEnum(name: string): string[] {
  // cwd is the crm/ package root under `vitest run`.
  const src = readFileSync(
    resolve(process.cwd(), "amplify/data/resource.ts"),
    "utf8"
  );
  const block = new RegExp(`${name}:\\s*a\\.enum\\(\\[([^\\]]*)\\]\\)`).exec(src);
  if (!block) throw new Error(`${name} enum not found in resource.ts`);
  return [...block[1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
}

const valuesOf = (opts: readonly { value: string }[]) => opts.map((o) => o.value);

describe("the derived types are still literal unions", () => {
  it("keeps every satisfies-guard live", () => {
    expect(stillLiteralUnions.every((v) => v === true)).toBe(true);
  });
});

describe("every table covers its schema enum exactly", () => {
  it("ConstructionType", () => {
    expect([...CONSTRUCTION_TYPES]).toEqual(schemaEnum("ConstructionType"));
    expect(Object.keys(CONSTRUCTION_LABELS).sort()).toEqual(
      schemaEnum("ConstructionType").sort()
    );
    expect(Object.keys(CONSTRUCTION_PHRASES).sort()).toEqual(
      schemaEnum("ConstructionType").sort()
    );
  });

  it("PolicyStatus", () => {
    expect([...POLICY_STATUSES].sort()).toEqual(schemaEnum("PolicyStatus").sort());
  });

  it("DocumentCategory — priority table is exhaustive", () => {
    expect(Object.keys(DOCUMENT_CATEGORY_EXTRACTION_PRIORITY).sort()).toEqual(
      schemaEnum("DocumentCategory").sort()
    );
  });

  it("UserRole", () => {
    expect([...USER_ROLES]).toEqual(schemaEnum("UserRole"));
    expect(Object.keys(USER_ROLE_LABELS).sort()).toEqual(
      schemaEnum("UserRole").sort()
    );
  });

  it("MarketingTaskResolution — the menu is every member but QUOTED", () => {
    // The close menu is built from MANUAL_TASK_RESOLUTIONS, so a resolution
    // added to the schema and not to that list is one nobody can ever pick —
    // it would compile, render, and simply be missing from the dropdown.
    expect([...MANUAL_TASK_RESOLUTIONS, "QUOTED"].sort()).toEqual(
      schemaEnum("MarketingTaskResolution").sort()
    );
    // And QUOTED stays out of it: it is detected from an existing quote, so
    // offering it would let someone record a quote that isn't there.
    expect(MANUAL_TASK_RESOLUTIONS).not.toContain("QUOTED");
  });

  it("LicenseClass / LicenseStatus / LicenseResidency", () => {
    expect(Object.keys(LICENSE_CLASS_LABELS).sort()).toEqual(
      schemaEnum("LicenseClass").sort()
    );
    expect(Object.keys(LICENSE_STATUS_LABELS).sort()).toEqual(
      schemaEnum("LicenseStatus").sort()
    );
    expect(valuesOf(LICENSE_RESIDENCY_OPTIONS).sort()).toEqual(
      schemaEnum("LicenseResidency").sort()
    );
  });

  it("ReplacementCostType — options and the 140's short codes agree", () => {
    const members = schemaEnum("ReplacementCostType").sort();
    expect(valuesOf(REPLACEMENT_COST_OPTIONS).sort()).toEqual(members);
    expect(Object.keys(REPLACEMENT_COST_CODES).sort()).toEqual(members);
    // The dropdown label carries an explanatory prefix; the form field takes
    // the bare code. Both come off the same member set, which is the point.
    expect(REPLACEMENT_COST_CODES.ERC).toBe("ERC");
  });

  it("AggregateAppliesTo — options and ACORD fields agree", () => {
    const members = schemaEnum("AggregateAppliesTo").sort();
    expect(valuesOf(AGGREGATE_APPLIES_TO_OPTIONS).sort()).toEqual(members);
    expect(Object.keys(ACORD25_AGGREGATE_FIELDS).sort()).toEqual(members);
  });

  it("ContactType — labels and options agree", () => {
    const members = schemaEnum("ContactType").sort();
    expect(Object.keys(CONTACT_TYPE_LABELS).sort()).toEqual(members);
    expect(valuesOf(CONTACT_TYPE_OPTIONS).sort()).toEqual(members);
    expect(members).toContain(DEFAULT_CONTACT_TYPE);
  });

  it("LegalEntityType — labels, options and ACORD fields agree", () => {
    const members = schemaEnum("LegalEntityType").sort();
    expect(Object.keys(LEGAL_ENTITY_LABELS).sort()).toEqual(members);
    expect(valuesOf(LEGAL_ENTITY_OPTIONS).sort()).toEqual(members);
    expect(Object.keys(ACORD125_LEGAL_ENTITY_FIELDS).sort()).toEqual(members);
    expect(members).toContain(DEFAULT_ASSOCIATION_LEGAL_ENTITY);
  });

  it("the W4 property enums — labels and options agree", () => {
    const pairs: [string, Record<string, string>, readonly { value: string }[]][] = [
      ["GlDeductibleType", GL_DEDUCTIBLE_TYPE_LABELS, GL_DEDUCTIBLE_TYPE_OPTIONS],
      [
        "BuildingDeductibleType",
        BUILDING_DEDUCTIBLE_TYPE_LABELS,
        BUILDING_DEDUCTIBLE_TYPE_OPTIONS,
      ],
      ["CauseOfLoss", CAUSE_OF_LOSS_LABELS, CAUSE_OF_LOSS_OPTIONS],
      ["GlPremiumBasis", GL_PREMIUM_BASIS_LABELS, GL_PREMIUM_BASIS_OPTIONS],
      ["DoCoverageType", DO_COVERAGE_TYPE_LABELS, DO_COVERAGE_TYPE_OPTIONS],
      [
        "DefenseLimitPosition",
        DEFENSE_LIMIT_POSITION_LABELS,
        DEFENSE_LIMIT_POSITION_OPTIONS,
      ],
    ];
    for (const [name, labels, options] of pairs) {
      const members = schemaEnum(name).sort();
      expect(Object.keys(labels).sort(), name).toEqual(members);
      expect(valuesOf(options).sort(), name).toEqual(members);
    }
  });

  it("DoPart — schema order is preserved, because the form prints A, B, C", () => {
    // The one list here that is NOT sorted by label: the parts are a fixed
    // sequence on the form, and rendering them alphabetically would be a
    // coincidence rather than a decision.
    expect([...DO_PARTS]).toEqual(schemaEnum("DoPart"));
    expect(Object.keys(DO_PART_LABELS).sort()).toEqual(schemaEnum("DoPart").sort());
  });

  it("AccountType — the shared copy matches the schema", () => {
    expect([...ACCOUNT_TYPES]).toEqual(schemaEnum("AccountType"));
  });
});

/**
 * Regression locks. Each of these is the literal list the migrated call site
 * rendered before it read from this module — same members, same order. They
 * are what proves the migration changed no visible output.
 */
describe("option lists reproduce the hand-written ones they replaced", () => {
  it("CONSTRUCTION_OPTIONS — property DetailsCard, alphabetical by label", () => {
    expect(CONSTRUCTION_OPTIONS.map((o) => [o.value, o.label])).toEqual([
      ["FIRE_RESISTIVE", "Fire Resistive"],
      ["FRAME", "Frame"],
      ["JOISTED_MASONRY", "Joisted Masonry"],
      ["MASONRY_NON_COMBUSTIBLE", "Masonry Non-Combustible"],
      ["MODIFIED_FIRE_RESISTIVE", "Modified Fire Resistive"],
      ["NON_COMBUSTIBLE", "Non-Combustible"],
    ]);
  });

  it("CONSTRUCTION_LABELS / _PHRASES — acordApp and ExtractionPanel", () => {
    expect({ ...CONSTRUCTION_LABELS }).toEqual({
      FRAME: "Frame",
      JOISTED_MASONRY: "Joisted Masonry",
      NON_COMBUSTIBLE: "Non-Combustible",
      MASONRY_NON_COMBUSTIBLE: "Masonry Non-Combustible",
      MODIFIED_FIRE_RESISTIVE: "Modified Fire Resistive",
      FIRE_RESISTIVE: "Fire Resistive",
    });
    expect({ ...CONSTRUCTION_PHRASES }).toEqual({
      FRAME: "wood-frame",
      JOISTED_MASONRY: "joisted masonry",
      NON_COMBUSTIBLE: "non-combustible",
      MASONRY_NON_COMBUSTIBLE: "masonry non-combustible",
      MODIFIED_FIRE_RESISTIVE: "modified fire-resistive",
      FIRE_RESISTIVE: "fire-resistive",
    });
  });

  it("POLICY_STATUSES — CoverageForm and PoliciesTab, alphabetical", () => {
    expect([...POLICY_STATUSES]).toEqual([
      "ACTIVE",
      "CANCELLED",
      "EXPIRED",
      "NON_RENEWED",
    ]);
  });

  it("REPLACEMENT_COST_OPTIONS — CoverageForm RC_TYPES", () => {
    expect(REPLACEMENT_COST_OPTIONS.map((o) => [o.value, o.label])).toEqual([
      ["ERC", "ERC — Extended Replacement Cost"],
      ["GRC", "GRC — Guaranteed Replacement Cost"],
      ["RC", "RC — Replacement Cost"],
    ]);
  });

  it("AGGREGATE_APPLIES_TO_OPTIONS — CoverageForm inline <option>s", () => {
    expect(AGGREGATE_APPLIES_TO_OPTIONS.map((o) => [o.value, o.label])).toEqual([
      ["LOCATION", "Location"],
      ["OTHER", "Other"],
      ["POLICY", "Policy"],
      ["PROJECT", "Project"],
    ]);
  });

  it("ACORD25_AGGREGATE_FIELDS — acord25 aggMap", () => {
    expect({ ...ACORD25_AGGREGATE_FIELDS }).toEqual({
      POLICY:
        "GeneralLiability_GeneralAggregate_LimitAppliesPerPolicyIndicator_A",
      PROJECT:
        "GeneralLiability_GeneralAggregate_LimitAppliesPerProjectIndicator_A",
      LOCATION:
        "GeneralLiability_GeneralAggregate_LimitAppliesPerLocationIndicator_A",
      OTHER:
        "GeneralLiability_GeneralAggregate_LimitAppliesToOtherIndicator_A",
    });
  });

  it("DOCUMENT_CATEGORY_OPTIONS — the panel's nine pickable categories", () => {
    expect(DOCUMENT_CATEGORY_OPTIONS.map((o) => [o.value, o.label])).toEqual([
      ["BUDGET", "Budget"],
      ["CONDO_DOCS", "Condo documents"],
      ["DUES_SCHEDULE", "Dues per unit"],
      ["LICENSE", "License"],
      ["LOSS_RUNS", "Loss runs"],
      ["OTHER", "Other"],
      ["POLICY_DOC", "Policy document"],
      ["PRIOR_POLICY", "Prior policy packet"],
      ["QUOTE_DOC", "Quote document"],
    ]);
  });

  it("DOCUMENT_CATEGORY_OPTIONS excludes ACORD_FORM, deliberately", () => {
    // Generated forms are not user-uploadable. The panel's label lookup falls
    // through to "—" for them, which is the behaviour this preserves.
    expect(valuesOf(DOCUMENT_CATEGORY_OPTIONS)).not.toContain("ACORD_FORM");
    expect(schemaEnum("DocumentCategory")).toContain("ACORD_FORM");
    expect(DOCUMENT_CATEGORY_OPTIONS).toHaveLength(
      schemaEnum("DocumentCategory").length - 1
    );
  });

  it("DOCUMENT_CATEGORY_EXTRACTION_PRIORITY — extract-lead CATEGORY_PRIORITY", () => {
    expect({ ...DOCUMENT_CATEGORY_EXTRACTION_PRIORITY }).toEqual({
      PRIOR_POLICY: 0,
      BUDGET: 1,
      DUES_SCHEDULE: 2,
      LOSS_RUNS: 3,
      OTHER: 4,
      QUOTE_DOC: 5,
      POLICY_DOC: 6,
      CONDO_DOCS: 7,
      ACORD_FORM: 8,
      LICENSE: 9,
    });
  });

  it("USER_ROLE_OPTIONS — Team invite <option>s, alphabetical by label", () => {
    expect(USER_ROLE_OPTIONS.map((o) => [o.value, o.label])).toEqual([
      ["ADMIN", "Admin"],
      ["PRODUCER", "Producer"],
      ["STAFF", "Staff"],
    ]);
  });

  it("USER_ROLE_LABELS — Onboarding ROLE_LABELS", () => {
    expect({ ...USER_ROLE_LABELS }).toEqual({
      ADMIN: "Admin",
      PRODUCER: "Producer",
      STAFF: "Staff",
    });
  });

  it("LICENSE_RESIDENCY_OPTIONS — Onboarding and LicenseForm <option>s", () => {
    expect(LICENSE_RESIDENCY_OPTIONS.map((o) => [o.value, o.label])).toEqual([
      ["NON_RESIDENT", "Non-resident"],
      ["RESIDENT", "Resident"],
    ]);
  });

  it("LICENSE_CLASS_LABELS / LICENSE_STATUS_LABELS — moved from client.ts", () => {
    expect({ ...LICENSE_CLASS_LABELS }).toEqual({
      AGENCY: "Agency / business entity",
      ADJUSTER: "Adjuster",
      CONSULTANT: "Consultant",
      PRODUCER: "Producer",
      SURPLUS_LINES: "Surplus lines",
    });
    expect({ ...LICENSE_STATUS_LABELS }).toEqual({
      ACTIVE: "Active",
      EXPIRED: "Expired",
      INACTIVE: "Inactive",
      LAPSED: "Lapsed",
      PENDING: "Pending",
    });
    // Both selects sort by label at render, so declaration order is not
    // load-bearing — but the label text is.
    expect(
      Object.values(LICENSE_CLASS_LABELS).sort((a, b) => a.localeCompare(b))
    ).toEqual([
      "Adjuster",
      "Agency / business entity",
      "Consultant",
      "Producer",
      "Surplus lines",
    ]);
  });

  it("CONTACT_TYPE_OPTIONS — the contacts card's role picker", () => {
    // No hand-written list preceded this one — the members are new in W1 — so
    // this locks the rendered order rather than reproducing an old one. It is
    // alphabetical by label, which is what `optionsByLabel` gives every list
    // in this file, and it means the schema's INSPECTION-first declaration
    // order does not decide what a producer sees first.
    expect(CONTACT_TYPE_OPTIONS.map((o) => [o.value, o.label])).toEqual([
      ["ACCOUNTING", "Accounting"],
      ["CLAIMS", "Claims"],
      ["DIRECTOR", "Director"],
      ["INSPECTION", "Inspection"],
      ["MANAGER", "Manager"],
      ["OTHER", "Other"],
      ["PRESIDENT", "President"],
      ["TRUSTEE", "Trustee"],
    ]);
  });

  it("LEGAL_ENTITY_OPTIONS — the Overview tab's entity picker", () => {
    expect(LEGAL_ENTITY_OPTIONS.map((o) => [o.value, o.label])).toEqual([
      ["CORPORATION", "Corporation"],
      ["INDIVIDUAL", "Individual"],
      ["JOINT_VENTURE", "Joint Venture"],
      ["LLC", "LLC"],
      ["NOT_FOR_PROFIT", "Not For Profit"],
      ["PARTNERSHIP", "Partnership"],
      ["SUBCHAPTER_S_CORP", "Subchapter S Corporation"],
      ["TRUST", "Trust"],
    ]);
  });

  it("ACORD125_LEGAL_ENTITY_FIELDS — the one confirmed name is unchanged", () => {
    // This is the field acordApp.ts hardcoded before W2, and the only one in
    // the table that has been seen on a real template. Every other name is
    // derived from its convention, so if this one ever changes the derivation
    // it anchors is no longer sound. The rest are pinned only to catch an
    // accidental edit — they are not evidence of anything.
    expect(ACORD125_LEGAL_ENTITY_FIELDS.NOT_FOR_PROFIT).toEqual([
      "NamedInsured_LegalEntity_NotForProfitIndicator_A",
    ]);
    for (const [member, fields] of Object.entries(ACORD125_LEGAL_ENTITY_FIELDS)) {
      expect(fields.length, `${member} has no candidates`).toBeGreaterThan(0);
      for (const f of fields) {
        expect(f).toMatch(/^NamedInsured_LegalEntity_\w+Indicator_A$/);
      }
    }
  });

  it("ACCOUNT_TYPE_OPTIONS — NewLead type <option>s", () => {
    expect(ACCOUNT_TYPE_OPTIONS.map((o) => [o.value, o.label])).toEqual([
      ["ASSOCIATION", "Association / HOA"],
      ["COMMERCIAL_OTHER", "Commercial — other"],
      ["PERSONAL", "Personal (HO-6)"],
    ]);
  });
});

/**
 * The extraction Lambda interpolates the member list into the prompt it sends
 * to the model. That is only safe while it renders exactly the string that was
 * hardcoded there before, so the text is pinned rather than trusted.
 */
describe("the extraction prompt's construction-type list", () => {
  it("renders the string the handler used to hardcode", () => {
    expect(
      `For "constructionType".value use exactly one of: ${CONSTRUCTION_TYPES.join(", ")}, or "".`
    ).toBe(
      'For "constructionType".value use exactly one of: FRAME, JOISTED_MASONRY, NON_COMBUSTIBLE, MASONRY_NON_COMBUSTIBLE, MODIFIED_FIRE_RESISTIVE, FIRE_RESISTIVE, or "".'
    );
  });

  it("is generated in the handler, not spelled out again", () => {
    const src = readFileSync(
      resolve(process.cwd(), "amplify/functions/extract-lead/handler.ts"),
      "utf8"
    );
    expect(src).toContain("${CONSTRUCTION_TYPES.join(\", \")}");
    // The uppercase value list must appear nowhere in the file as a literal.
    expect(src).not.toContain("MASONRY_NON_COMBUSTIBLE,");
  });
});

describe("isAccountType", () => {
  it("accepts every schema member", () => {
    for (const t of ACCOUNT_TYPES) expect(isAccountType(t)).toBe(true);
  });

  it("rejects non-members, nullish input and inherited properties", () => {
    for (const bad of ["", "association", "LEAD", null, undefined, "toString"]) {
      expect(isAccountType(bad)).toBe(false);
    }
  });
});

describe("frozen, so a consumer cannot mutate a shared list", () => {
  // `ACCOUNT_TYPES` is excluded: it lives in `shared/`, which is `as const`
  // and dependency-free by house style (see shared/agency.ts) — compile-time
  // readonly, no runtime freeze.
  it("freezes every exported list and table", () => {
    for (const v of [
      CONSTRUCTION_TYPES,
      CONSTRUCTION_OPTIONS,
      CONSTRUCTION_LABELS,
      POLICY_STATUSES,
      DOCUMENT_CATEGORY_OPTIONS,
      USER_ROLE_OPTIONS,
      LICENSE_CLASS_LABELS,
    ]) {
      expect(Object.isFrozen(v)).toBe(true);
    }
  });
});

/**
 * The anti-vacuity check. `shared/accountType.ts` is the one hand-written enum
 * copy left standing, because `web` cannot import the schema. Its compile-time
 * guard lives in enums.ts; this asserts the runtime values too, and that the
 * web consumer actually reads from the shared module rather than re-typing the
 * union locally again. Modelled on sharedAgency.test.ts:196-217.
 */
describe("the shared AccountType copy cannot drift", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

  it("holds exactly the schema's members, in schema order", () => {
    const literals = [
      ...read("../shared/accountType.ts").matchAll(/"([A-Z_]+)"/g),
    ].map((m) => m[1]);
    expect(literals).toEqual(schemaEnum("AccountType"));
  });

  it("is what web/src/lib/crmLead.ts reads, not a fourth copy", () => {
    const text = read("../web/src/lib/crmLead.ts");
    const importsShared = /from\s+"[^"]*shared\/accountType"/.test(text);
    expect(
      importsShared,
      "web/src/lib/crmLead.ts no longer imports shared/accountType"
    ).toBe(true);
    // And it must not have re-typed the union inline alongside the import.
    expect(text).not.toMatch(/"ASSOCIATION"\s*\|\s*"PERSONAL"/);
  });
});
