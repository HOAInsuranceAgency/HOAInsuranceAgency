/**
 * The one place the schema's enums are named.
 *
 * `amplify/data/resource.ts` declares 19 `a.enum(...)` types. Before this
 * module they were re-typed by hand all over the app — as `Record<string, …>`
 * label maps, literal unions, runtime `Set`s, `[value, label]` tuples and
 * inline `<option>` lists — none of it checked against the schema. Adding or
 * renaming a member compiled clean everywhere and failed at runtime. It had
 * already happened once: the Documents panel's category list was missing
 * `ACORD_FORM`, so an ACORD document rendered with no category label at all.
 *
 * How drift is prevented, following `quoteStatus.ts`: every table below is
 * `satisfies Record<TheEnum, …>`, where the enum is `Schema["X"]["type"]` —
 * the schema's own type. Add a member in `resource.ts` and this file stops
 * compiling until the member is given a label; remove one and the now-excess
 * key stops compiling too. Ordered lists are *derived* from those tables by
 * sorting, never written out a second time, so a display order cannot fall out
 * of step with the member set.
 *
 * `satisfies` rather than `:` on purpose — it enforces exhaustiveness while
 * leaving the literal key types intact for the derivations below. The exported
 * label maps are then widened to `Record<string, string>` so callers can keep
 * indexing them with a loose `string | null` straight off a model row.
 *
 * `QuoteStatus` is not here: `quoteStatus.ts` already owns it, with a
 * classification this module has no business duplicating.
 *
 * ─ Import constraints ────────────────────────────────────────────────────────
 * Type-only import of `Schema`, so nothing from `amplify/` reaches a bundle or
 * a test run. Combined with importing no runtime value except the
 * dependency-free `shared/accountType`, that makes this module safe for a
 * Lambda handler to import — the `pagination.ts` convention. It must never
 * import `client.ts`, which calls `generateClient()` at module scope.
 */
import type { Schema } from "../../amplify/data/resource";
import { ACCOUNT_TYPES, type AccountType } from "../../../shared/accountType";

// ── Derived enum types ───────────────────────────────────────────────────────

export type AccountStage = Schema["AccountStage"]["type"];
export type PolicyStatus = Schema["PolicyStatus"]["type"];
export type BillType = Schema["BillType"]["type"];
export type DocumentCategory = NonNullable<Schema["DocumentCategory"]["type"]>;
export type OcrStatus = Schema["OcrStatus"]["type"];
export type UserRole = Schema["UserRole"]["type"];
export type MarketingTaskResolution = Schema["MarketingTaskResolution"]["type"];
export type MarketingTaskSource = Schema["MarketingTaskSource"]["type"];
export type LicenseHolderType = Schema["LicenseHolderType"]["type"];
export type LicenseClass = Schema["LicenseClass"]["type"];
export type LicenseResidency = Schema["LicenseResidency"]["type"];
export type LicenseStatus = Schema["LicenseStatus"]["type"];
export type ConstructionType = Schema["ConstructionType"]["type"];
export type ReplacementCostType = Schema["ReplacementCostType"]["type"];
export type BuildingDeductibleType = NonNullable<
  Schema["BuildingDeductibleType"]["type"]
>;
export type CauseOfLoss = NonNullable<Schema["CauseOfLoss"]["type"]>;
export type AggregateAppliesTo = Schema["AggregateAppliesTo"]["type"];
export type ContactType = NonNullable<Schema["ContactType"]["type"]>;
export type LegalEntityType = NonNullable<Schema["LegalEntityType"]["type"]>;
export type GlDeductibleType = NonNullable<Schema["GlDeductibleType"]["type"]>;
export type GlPremiumBasis = NonNullable<Schema["GlPremiumBasis"]["type"]>;
export type DoPart = NonNullable<Schema["DoPart"]["type"]>;
export type DoCoverageType = NonNullable<Schema["DoCoverageType"]["type"]>;
export type DefenseLimitPosition = NonNullable<
  Schema["DefenseLimitPosition"]["type"]
>;

/**
 * `AccountType` is re-exported from `shared/` rather than derived here: `web`
 * needs it too and cannot reach the schema. These two assertions are what stop
 * the shared copy drifting — they fail compilation if the shared list gains,
 * loses or renames a member relative to the schema.
 */
type SchemaAccountType = Schema["AccountType"]["type"];
type SharedCoversSchema = [SchemaAccountType] extends [AccountType] ? true : never;
type SchemaCoversShared = [AccountType] extends [SchemaAccountType] ? true : never;
const _sharedMatchesSchema: [SharedCoversSchema, SchemaCoversShared] = [true, true];
void _sharedMatchesSchema;

export { ACCOUNT_TYPES, type AccountType };

// ── Option lists ─────────────────────────────────────────────────────────────

/** One `<option>`: the stored enum value plus the text shown for it. */
export interface EnumOption<K extends string> {
  readonly value: K;
  readonly label: string;
}

/**
 * Turn a label table into the option list a `<select>` renders, sorted by
 * label. Every list in this file was alphabetical-by-label where it was
 * written by hand, so sorting reproduces the existing order rather than
 * restating it — which is the point: there is no second copy of the members to
 * fall out of step.
 */
function optionsByLabel<K extends string>(
  table: Record<K, string>
): readonly EnumOption<K>[] {
  return Object.freeze(
    (Object.keys(table) as K[])
      .map((value) => Object.freeze({ value, label: table[value] }))
      .sort((a, b) => a.label.localeCompare(b.label))
  );
}

// ── ConstructionType ─────────────────────────────────────────────────────────

/**
 * ISO construction classes. Two renderings, one table: `label` is the Title
 * Case form shown in dropdowns and the extraction review, `phrase` is the
 * lower-case form that reads correctly inside the ACORD operations sentence.
 */
const CONSTRUCTION = {
  FRAME: { label: "Frame", phrase: "wood-frame" },
  JOISTED_MASONRY: { label: "Joisted Masonry", phrase: "joisted masonry" },
  NON_COMBUSTIBLE: { label: "Non-Combustible", phrase: "non-combustible" },
  MASONRY_NON_COMBUSTIBLE: {
    label: "Masonry Non-Combustible",
    phrase: "masonry non-combustible",
  },
  MODIFIED_FIRE_RESISTIVE: {
    label: "Modified Fire Resistive",
    phrase: "modified fire-resistive",
  },
  FIRE_RESISTIVE: { label: "Fire Resistive", phrase: "fire-resistive" },
} satisfies Record<ConstructionType, { label: string; phrase: string }>;

/** Every construction class, in schema order. */
export const CONSTRUCTION_TYPES: readonly ConstructionType[] = Object.freeze(
  Object.keys(CONSTRUCTION) as ConstructionType[]
);

export const CONSTRUCTION_LABELS: Record<string, string> = Object.freeze(
  Object.fromEntries(
    CONSTRUCTION_TYPES.map((k) => [k, CONSTRUCTION[k].label])
  ) as Record<ConstructionType, string>
);

export const CONSTRUCTION_PHRASES: Record<string, string> = Object.freeze(
  Object.fromEntries(
    CONSTRUCTION_TYPES.map((k) => [k, CONSTRUCTION[k].phrase])
  ) as Record<ConstructionType, string>
);

export const CONSTRUCTION_OPTIONS = optionsByLabel(
  CONSTRUCTION_LABELS as Record<ConstructionType, string>
);

// ── PolicyStatus ─────────────────────────────────────────────────────────────

/**
 * No labels: every policy-status `<select>` renders the raw token, and the
 * badge table in `badges.tsx` owns the coloured rendering.
 */
const POLICY_STATUS = {
  ACTIVE: true,
  EXPIRED: true,
  CANCELLED: true,
  NON_RENEWED: true,
} satisfies Record<PolicyStatus, true>;

/**
 * Alphabetical, which is the order both hand-written copies used — the
 * `CoverageForm` list re-sorts at render anyway, the `PoliciesTab` one does
 * not, so this order is load-bearing there.
 */
export const POLICY_STATUSES: readonly PolicyStatus[] = Object.freeze(
  (Object.keys(POLICY_STATUS) as PolicyStatus[]).sort((a, b) =>
    a.localeCompare(b)
  )
);

// ── BillType ─────────────────────────────────────────────────────────────────

/**
 * Labelled "… bill" rather than bare, because "Agency"/"Direct" alone reads as
 * a question about who the agency is. The distinction decides whether the
 * agency ever raises an invoice for the premium — see `BillType` in the schema.
 */
const BILL_TYPE = {
  AGENCY: "Agency bill — we collect and remit",
  DIRECT: "Direct bill — the carrier collects",
} satisfies Record<BillType, string>;

export const BILL_TYPE_LABELS: Record<string, string> = Object.freeze(BILL_TYPE);

export const BILL_TYPE_OPTIONS = optionsByLabel(BILL_TYPE);

/** The short form, for a table cell that has no room for the explanation. */
export const BILL_TYPE_SHORT: Record<string, string> = Object.freeze({
  AGENCY: "Agency",
  DIRECT: "Direct",
} satisfies Record<BillType, string>);

// ── ReplacementCostType ──────────────────────────────────────────────────────

const REPLACEMENT_COST = {
  RC: "RC — Replacement Cost",
  ERC: "ERC — Extended Replacement Cost",
  GRC: "GRC — Guaranteed Replacement Cost",
} satisfies Record<ReplacementCostType, string>;

export const REPLACEMENT_COST_OPTIONS = optionsByLabel(REPLACEMENT_COST);

// ── Per-building property terms ──────────────────────────────────────────────

/**
 * The 140's subject-of-insurance row asks for a deductible type and a cause of
 * loss as **text**, not as checkboxes.
 *
 * The field inventory (docs/acord/acord-140-fields.txt) gives field names; it
 * does not give the code vocabulary those fields expect. So the mapping writes
 * the label below rather than an invented ACORD code: an underwriter reads
 * this row, "Per occurrence" is unambiguous to a human, and a guessed code
 * that is wrong is a wrong value rather than a blank.
 */
const BUILDING_DEDUCTIBLE_TYPE = {
  PER_OCCURRENCE: "Per occurrence",
  OTHER: "Other",
} satisfies Record<BuildingDeductibleType, string>;

export const BUILDING_DEDUCTIBLE_TYPE_OPTIONS = optionsByLabel(
  BUILDING_DEDUCTIBLE_TYPE
);

export const BUILDING_DEDUCTIBLE_TYPE_LABELS: Record<string, string> =
  Object.freeze({ ...BUILDING_DEDUCTIBLE_TYPE });

/** The three standard commercial property causes-of-loss forms. */
const CAUSE_OF_LOSS = {
  SPECIAL: "Special",
  BASIC: "Basic",
  BROAD: "Broad",
} satisfies Record<CauseOfLoss, string>;

export const CAUSE_OF_LOSS_OPTIONS = optionsByLabel(CAUSE_OF_LOSS);

export const CAUSE_OF_LOSS_LABELS: Record<string, string> = Object.freeze({
  ...CAUSE_OF_LOSS,
});

/**
 * `ReplacementCostType`'s labels carry an "RC — " prefix for the dropdown,
 * which is not what should land in the 140's valuation field. This is the
 * short form for the form.
 */
export const REPLACEMENT_COST_CODES: Record<string, string> = Object.freeze({
  RC: "RC",
  ERC: "ERC",
  GRC: "GRC",
} satisfies Record<ReplacementCostType, string>);

// ── AggregateAppliesTo ───────────────────────────────────────────────────────

/**
 * `label` is the dropdown text; `acord25Field` is the ACORD 25 checkbox this
 * choice ticks. Keeping both here is what stops the PDF mapping and the form
 * offering different member sets.
 */
const AGGREGATE_APPLIES_TO = {
  POLICY: {
    label: "Policy",
    acord25Field:
      "GeneralLiability_GeneralAggregate_LimitAppliesPerPolicyIndicator_A",
  },
  PROJECT: {
    label: "Project",
    acord25Field:
      "GeneralLiability_GeneralAggregate_LimitAppliesPerProjectIndicator_A",
  },
  LOCATION: {
    label: "Location",
    acord25Field:
      "GeneralLiability_GeneralAggregate_LimitAppliesPerLocationIndicator_A",
  },
  OTHER: {
    label: "Other",
    acord25Field:
      "GeneralLiability_GeneralAggregate_LimitAppliesToOtherIndicator_A",
  },
} satisfies Record<AggregateAppliesTo, { label: string; acord25Field: string }>;

/** The member every caller falls back to when the column is unset. */
export const DEFAULT_AGGREGATE_APPLIES_TO = "POLICY" satisfies AggregateAppliesTo;

export const AGGREGATE_APPLIES_TO_OPTIONS = optionsByLabel(
  Object.fromEntries(
    (Object.keys(AGGREGATE_APPLIES_TO) as AggregateAppliesTo[]).map((k) => [
      k,
      AGGREGATE_APPLIES_TO[k].label,
    ])
  ) as Record<AggregateAppliesTo, string>
);

export const ACORD25_AGGREGATE_FIELDS: Record<string, string> = Object.freeze(
  Object.fromEntries(
    (Object.keys(AGGREGATE_APPLIES_TO) as AggregateAppliesTo[]).map((k) => [
      k,
      AGGREGATE_APPLIES_TO[k].acord25Field,
    ])
  ) as Record<AggregateAppliesTo, string>
);

// ── LegalEntityType ──────────────────────────────────────────────────────────

/**
 * How the applicant is organised, and the ACORD 125 checkbox each choice
 * ticks. Same shape as `AGGREGATE_APPLIES_TO` above and for the same reason:
 * the dropdown and the PDF mapping read one table, so they cannot come to
 * offer different member sets.
 *
 * **Every name here is confirmed** against the agency's own template — see
 * `docs/acord/acord-125-fields.txt`, which is the full field inventory read
 * with Settings → Inspect fields. Seven of the eight were derived guesses
 * when W2 shipped; the inventory confirmed all seven and settled the one
 * genuine coin-flip: an LLC is `LimitedLiabilityCorporation`, not
 * `…Company`, so the second candidate that covered it is gone.
 *
 * The member set matches the form's exactly, minus its `OtherIndicator_A`
 * box — the enum has no OTHER member, so nothing can select it. The form also
 * carries `MemberManagerCount_A` beside the LLC box, which the CRM does not
 * record.
 *
 * Lists rather than single names, unlike `AGGREGATE_APPLIES_TO`, because the
 * form has an _A/_B/_C set of these for three named insureds and a later
 * workstream filling the second one will add candidates here rather than a
 * second table.
 */
const LEGAL_ENTITY = {
  CORPORATION: {
    label: "Corporation",
    acord125Fields: ["NamedInsured_LegalEntity_CorporationIndicator_A"],
  },
  INDIVIDUAL: {
    label: "Individual",
    acord125Fields: ["NamedInsured_LegalEntity_IndividualIndicator_A"],
  },
  JOINT_VENTURE: {
    label: "Joint Venture",
    acord125Fields: ["NamedInsured_LegalEntity_JointVentureIndicator_A"],
  },
  LLC: {
    label: "LLC",
    acord125Fields: [
      "NamedInsured_LegalEntity_LimitedLiabilityCorporationIndicator_A",
    ],
  },
  NOT_FOR_PROFIT: {
    label: "Not For Profit",
    acord125Fields: ["NamedInsured_LegalEntity_NotForProfitIndicator_A"],
  },
  PARTNERSHIP: {
    label: "Partnership",
    acord125Fields: ["NamedInsured_LegalEntity_PartnershipIndicator_A"],
  },
  SUBCHAPTER_S_CORP: {
    label: "Subchapter S Corporation",
    acord125Fields: ["NamedInsured_LegalEntity_SubchapterSCorporationIndicator_A"],
  },
  TRUST: {
    label: "Trust",
    acord125Fields: ["NamedInsured_LegalEntity_TrustIndicator_A"],
  },
} satisfies Record<
  LegalEntityType,
  { label: string; acord125Fields: readonly string[] }
>;

export const LEGAL_ENTITY_OPTIONS = optionsByLabel(
  Object.fromEntries(
    (Object.keys(LEGAL_ENTITY) as LegalEntityType[]).map((k) => [
      k,
      LEGAL_ENTITY[k].label,
    ])
  ) as Record<LegalEntityType, string>
);

export const LEGAL_ENTITY_LABELS: Record<string, string> = Object.freeze(
  Object.fromEntries(
    (Object.keys(LEGAL_ENTITY) as LegalEntityType[]).map((k) => [
      k,
      LEGAL_ENTITY[k].label,
    ])
  ) as Record<LegalEntityType, string>
);

export const ACORD125_LEGAL_ENTITY_FIELDS: Record<string, readonly string[]> =
  Object.freeze(
    Object.fromEntries(
      (Object.keys(LEGAL_ENTITY) as LegalEntityType[]).map((k) => [
        k,
        Object.freeze([...LEGAL_ENTITY[k].acord125Fields]),
      ])
    ) as Record<LegalEntityType, readonly string[]>
  );

/**
 * What an ASSOCIATION with no stated entity type is treated as on the 125.
 *
 * Before `legalEntityType` existed, `acordApp` ticked Not-For-Profit for
 * every ASSOCIATION and nothing else, unconditionally. Every account already
 * in the system predates the column, so without this fallback shipping W2
 * would silently *untick* a box on every existing association's next
 * submission — a regression dressed as a new feature.
 */
export const DEFAULT_ASSOCIATION_LEGAL_ENTITY =
  "NOT_FOR_PROFIT" satisfies LegalEntityType;

// ── ContactType ──────────────────────────────────────────────────────────────

/**
 * What a contact is *for*. Labels only — the ACORD 125 does not have a
 * per-role checkbox; it has one contact slot with a free-text description, and
 * `acordApp` writes the label of the contact it picked into it. So unlike
 * `AGGREGATE_APPLIES_TO` there is no field name to carry alongside.
 *
 * `INSPECTION` is load-bearing rather than decorative: the 125's inspection
 * block is filled from the first contact carrying it, which is what replaced
 * `Account.inspectionContactName` / `…Phone`.
 */
const CONTACT_TYPE = {
  INSPECTION: "Inspection",
  CLAIMS: "Claims",
  ACCOUNTING: "Accounting",
  MANAGER: "Manager",
  TRUSTEE: "Trustee",
  DIRECTOR: "Director",
  PRESIDENT: "President",
  OTHER: "Other",
} satisfies Record<ContactType, string>;

/**
 * Every role, in schema order. The extraction Lambda interpolates this into
 * its prompt and its JSON schema, the same way `CONSTRUCTION_TYPES` is — so
 * the model can only ever return a role the app knows how to store.
 */
export const CONTACT_TYPES: readonly ContactType[] = Object.freeze(
  Object.keys(CONTACT_TYPE) as ContactType[]
);

export const CONTACT_TYPE_LABELS: Record<string, string> = Object.freeze({
  ...CONTACT_TYPE,
});

export const CONTACT_TYPE_OPTIONS = optionsByLabel(CONTACT_TYPE);

/**
 * What a contact with no stated role is recorded as — by the backfill, which
 * is turning two anonymous columns into people, and by the extraction apply
 * path when the documents name someone without saying what they do.
 */
export const DEFAULT_CONTACT_TYPE = "OTHER" satisfies ContactType;

// ── General liability application ────────────────────────────────────────────

const GL_DEDUCTIBLE_TYPE = {
  PER_OCCURRENCE: "Per occurrence",
  PER_CLAIM: "Per claim",
} satisfies Record<GlDeductibleType, string>;

export const GL_DEDUCTIBLE_TYPE_OPTIONS = optionsByLabel(GL_DEDUCTIBLE_TYPE);

export const GL_DEDUCTIBLE_TYPE_LABELS: Record<string, string> = Object.freeze({
  ...GL_DEDUCTIBLE_TYPE,
});

/**
 * What a class code's exposure is measured in. "Unit" is the one that matters
 * for this agency — an association's GL exposure is rated per residential
 * unit — and OTHER covers the class codes that are rated on area, payroll or
 * receipts, where the basis is written into the description instead.
 */
const GL_PREMIUM_BASIS = {
  UNIT: "Per unit",
  OTHER: "Other",
} satisfies Record<GlPremiumBasis, string>;

export const GL_PREMIUM_BASIS_OPTIONS = optionsByLabel(GL_PREMIUM_BASIS);

export const GL_PREMIUM_BASIS_LABELS: Record<string, string> = Object.freeze({
  ...GL_PREMIUM_BASIS,
});

// ── Directors & Officers ─────────────────────────────────────────────────────

/**
 * The three coverage parts, labelled neutrally.
 *
 * **Deliberately not "Side A / Side B / Side C".** That is standard D&O
 * terminology for a specific split — personal liability the entity cannot
 * indemnify, reimbursement of the entity for indemnification, and entity
 * securities cover — and this agency's parts carry a primary/excess type and
 * their own retentions per part, which reads more like layers of a tower than
 * the Side split. Naming them Side A/B/C would assert a meaning nobody has
 * confirmed, on a form that goes to a carrier.
 *
 * Open question 4 in docs/specs/lead-client-expansion.md. When it is
 * answered, the labels change here and nowhere else.
 */
const DO_PART = {
  A: "Part A",
  B: "Part B",
  C: "Part C",
} satisfies Record<DoPart, string>;

/** Schema order — A, B, C — which is the order the form prints them in. */
export const DO_PARTS: readonly DoPart[] = Object.freeze(
  Object.keys(DO_PART) as DoPart[]
);

export const DO_PART_LABELS: Record<string, string> = Object.freeze({
  ...DO_PART,
});

const DO_COVERAGE_TYPE = {
  PRIMARY: "Primary",
  EXCESS: "Excess",
} satisfies Record<DoCoverageType, string>;

export const DO_COVERAGE_TYPE_OPTIONS = optionsByLabel(DO_COVERAGE_TYPE);

export const DO_COVERAGE_TYPE_LABELS: Record<string, string> = Object.freeze({
  ...DO_COVERAGE_TYPE,
});

/**
 * Whether defence costs erode the limit ("inside") or sit on top of it
 * ("outside"). The distinction is worth real money on a claim, which is why
 * it is a stored answer rather than a note.
 */
const DEFENSE_LIMIT_POSITION = {
  INSIDE: "Inside the limit",
  OUTSIDE: "Outside the limit",
} satisfies Record<DefenseLimitPosition, string>;

export const DEFENSE_LIMIT_POSITION_OPTIONS = optionsByLabel(
  DEFENSE_LIMIT_POSITION
);

export const DEFENSE_LIMIT_POSITION_LABELS: Record<string, string> =
  Object.freeze({ ...DEFENSE_LIMIT_POSITION });

// ── DocumentCategory ─────────────────────────────────────────────────────────

/**
 * `label: null` means "not something a human uploads". `ACORD_FORM` is the
 * only such member: those documents are generated by the forms tab, so the
 * category is deliberately absent from the upload picker — and, because the
 * picker doubles as the table's label lookup, an ACORD document shows no
 * category. That is existing behaviour, preserved here on purpose; making it
 * `null` is what turns an accidental omission into a checked one.
 *
 * `extractionPriority` is the order the AI extraction Lambda feeds documents
 * to the model when it has to fit them in a character budget — lowest first.
 */
/**
 * ## `extractable`
 *
 * Whether the AI extraction pass is given this document's text at all.
 *
 * It is not a judgement about how useful the document is to a human. A budget
 * and a master deed are both worth having on the account; neither is worth
 * spending the extraction budget on. `extract-lead` works to a 400,000-character
 * ceiling, and once the upload portal started asking for governing documents,
 * a hundred-page master deed sorted above the declaration page would quietly eat
 * that ceiling and starve the one document the reply actually needed. Truncation
 * is silent, which is what makes it worth excluding these rather than ranking
 * them last.
 *
 * The rule: extractable if a named datapoint in EXTRACTION_SCHEMA comes off it.
 * Carrier, term, limits, values and loss history do. "Where the master policy
 * ends" does not — that is a reading job, and a producer does it.
 */
const DOCUMENT_CATEGORY = {
  PRIOR_POLICY: {
    label: "Prior policy packet",
    extractionPriority: 0,
    extractable: true,
  },
  CONDO_DOCS: { label: "Condo documents", extractionPriority: 7, extractable: false },
  BUDGET: { label: "Budget", extractionPriority: 1, extractable: false },
  DUES_SCHEDULE: { label: "Dues per unit", extractionPriority: 2, extractable: true },
  LOSS_RUNS: { label: "Loss runs", extractionPriority: 3, extractable: true },
  QUOTE_DOC: { label: "Quote document", extractionPriority: 5, extractable: true },
  POLICY_DOC: { label: "Policy document", extractionPriority: 6, extractable: true },
  LICENSE: { label: "License", extractionPriority: 9, extractable: false },
  ACORD_FORM: { label: null, extractionPriority: 8, extractable: false },
  STATEMENT_OF_VALUES: {
    label: "Statement of values",
    extractionPriority: 1,
    extractable: true,
  },
  PROPERTY_UPDATES: {
    label: "Building updates",
    extractionPriority: 4,
    extractable: true,
  },
  /**
   * Extractable, unlike the other three that are not.
   *
   * OTHER is where every uncategorised document lands, including everything the
   * post-submit panel accepts before anyone has looked at it. Excluding it would
   * mean a lead who uploads their dec page from the confirmation screen gets no
   * extraction at all, which is the case this whole pipeline was built for.
   */
  OTHER: { label: "Other", extractionPriority: 4, extractable: true },
} satisfies Record<
  DocumentCategory,
  { label: string | null; extractionPriority: number; extractable: boolean }
>;

/** Categories a human may pick when uploading, sorted by label. */
export const DOCUMENT_CATEGORY_OPTIONS: readonly EnumOption<DocumentCategory>[] =
  Object.freeze(
    (Object.keys(DOCUMENT_CATEGORY) as DocumentCategory[])
      .flatMap((value) => {
        const { label } = DOCUMENT_CATEGORY[value];
        return label === null ? [] : [Object.freeze({ value, label })];
      })
      .sort((a, b) => a.label.localeCompare(b.label))
  );

/** Feed order for the extraction Lambda's character budget. Lowest first. */
export const DOCUMENT_CATEGORY_EXTRACTION_PRIORITY: Record<string, number> =
  Object.freeze(
    Object.fromEntries(
      (Object.keys(DOCUMENT_CATEGORY) as DocumentCategory[]).map((k) => [
        k,
        DOCUMENT_CATEGORY[k].extractionPriority,
      ])
    ) as Record<DocumentCategory, number>
  );

/** Where an uncategorised document sorts, and what it is treated as. */
export const DEFAULT_DOCUMENT_CATEGORY = "OTHER" satisfies DocumentCategory;

/**
 * Categories whose text the extraction pass reads. See `extractable` above.
 *
 * A plain predicate rather than a set the caller filters with, so an unknown
 * category coming off an old row falls to whatever OTHER does rather than to
 * `false` — a document nobody has categorised is the common case, not an
 * excluded one.
 */
export function isExtractableCategory(category: string | null | undefined): boolean {
  const key = (category ?? DEFAULT_DOCUMENT_CATEGORY) as DocumentCategory;
  return (DOCUMENT_CATEGORY[key] ?? DOCUMENT_CATEGORY[DEFAULT_DOCUMENT_CATEGORY])
    .extractable;
}

// ── UserRole ─────────────────────────────────────────────────────────────────

const USER_ROLE = {
  ADMIN: "Admin",
  STAFF: "Staff",
  PRODUCER: "Producer",
} satisfies Record<UserRole, string>;

export const USER_ROLES: readonly UserRole[] = Object.freeze(
  Object.keys(USER_ROLE) as UserRole[]
);

export const USER_ROLE_LABELS: Record<string, string> = Object.freeze({
  ...USER_ROLE,
});

export const USER_ROLE_OPTIONS = optionsByLabel(USER_ROLE);

/** The role a new invite gets when none is chosen. */
export const DEFAULT_USER_ROLE = "STAFF" satisfies UserRole;

/**
 * Is this one of the schema's roles? These are also the Cognito group names —
 * `amplify/auth/resource.ts` declares the same three — which is why the team
 * admin Lambda can validate an invite's role and then pass it straight to
 * `AdminAddUserToGroupCommand`.
 */
export function isUserRole(v: string | null | undefined): v is UserRole {
  return v != null && (USER_ROLES as readonly string[]).includes(v);
}

// ── MarketingTaskResolution ──────────────────────────────────────────────────

/**
 * The resolutions a person can pick when closing a task by hand, in menu
 * order — worst-fit first, missed-deadline last.
 *
 * `QUOTED` is absent by design and is the reason this list exists rather than
 * the enum being used directly: a task becomes QUOTED because a quote was
 * found for that carrier, detected by the nightly sweep and again on load.
 * Offering it in the menu would let someone record a quote that isn't there.
 *
 * Only the keys live here. The labels are `MARKETING_RESOLUTION_BADGE`'s, so
 * the menu and the badge on the closed row cannot end up saying different
 * things about the same value — which is exactly what a second label table
 * would eventually do.
 */
export const MANUAL_TASK_RESOLUTIONS = [
  "OUT_OF_APPETITE",
  "OUT_OF_AGENCY_APPETITE",
  "NOT_SUBMITTED_ON_TIME",
] as const satisfies readonly MarketingTaskResolution[];

/** A resolution a person may choose — everything but `QUOTED`. */
export type ManualTaskResolution = (typeof MANUAL_TASK_RESOLUTIONS)[number];

// ── Licensing ────────────────────────────────────────────────────────────────

const LICENSE_CLASS = {
  PRODUCER: "Producer",
  AGENCY: "Agency / business entity",
  SURPLUS_LINES: "Surplus lines",
  ADJUSTER: "Adjuster",
  CONSULTANT: "Consultant",
} satisfies Record<LicenseClass, string>;

export const LICENSE_CLASS_LABELS: Record<string, string> = Object.freeze({
  ...LICENSE_CLASS,
});

const LICENSE_STATUS = {
  ACTIVE: "Active",
  PENDING: "Pending",
  INACTIVE: "Inactive",
  LAPSED: "Lapsed",
  EXPIRED: "Expired",
} satisfies Record<LicenseStatus, string>;

export const LICENSE_STATUS_LABELS: Record<string, string> = Object.freeze({
  ...LICENSE_STATUS,
});

const LICENSE_RESIDENCY = {
  RESIDENT: "Resident",
  NON_RESIDENT: "Non-resident",
} satisfies Record<LicenseResidency, string>;

export const LICENSE_RESIDENCY_OPTIONS = optionsByLabel(LICENSE_RESIDENCY);

// ── AccountType ──────────────────────────────────────────────────────────────

const ACCOUNT_TYPE = {
  ASSOCIATION: "Association / HOA",
  PERSONAL: "Personal (HO-6)",
  COMMERCIAL_OTHER: "Commercial — other",
} satisfies Record<AccountType, string>;

export const ACCOUNT_TYPE_OPTIONS = optionsByLabel(ACCOUNT_TYPE);

/** What a lead with no stated type is recorded as. */
export const DEFAULT_ACCOUNT_TYPE = "ASSOCIATION" satisfies AccountType;

/** Is this one of the schema's account types at all? */
export function isAccountType(v: string | null | undefined): v is AccountType {
  return v != null && (ACCOUNT_TYPES as readonly string[]).includes(v);
}
