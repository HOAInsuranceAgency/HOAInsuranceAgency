// Carrier-submission application forms: the shared eForm header plus the
// ACORD 125 and 140 sections. Public entry point: ./acord.ts

import { AGENCY } from "./agency";
import type { Account } from "./client";
import type { AcordFormDef } from "./acordRegistry";
import { fmtUs, todayUs } from "./acordFormat";
import { inspectionContact, primaryContact, type ContactLike } from "./contacts";
import {
  ACORD125_LEGAL_ENTITY_FIELDS,
  BUILDING_DEDUCTIBLE_TYPE_LABELS,
  CAUSE_OF_LOSS_LABELS,
  CONSTRUCTION_LABELS,
  CONSTRUCTION_PHRASES,
  CONTACT_TYPE_LABELS,
  DEFAULT_ASSOCIATION_LEGAL_ENTITY,
  REPLACEMENT_COST_CODES,
  type LegalEntityType,
} from "./enums";
import {
  fillTemplate,
  type FieldValues,
  type FillResult,
  type SignatureInfo,
} from "./acordPdf";

// ── Carrier-submission application forms (125 / 126 / 140 / 151) ──────

interface BuildingInfo {
  label?: string | null;
  sqft?: number | null;
  streetAddress?: string | null;
  description?: string | null;
  yearBuilt?: number | null;
  stories?: number | null;
  basements?: number | null;
  constructionType?: string | null;
  roofType?: string | null;
  roofYear?: number | null;
  heatingYear?: number | null;
  wiringYear?: number | null;
  plumbingYear?: number | null;
  distanceToHydrantFt?: number | null;
  distanceToFireStationMi?: number | null;
  fireProtectionType?: string | null;
  sprinklerPct?: number | null;
  individualBuildingValue?: number | null;
  coinsurancePct?: number | null;
  valuation?: string | null;
  deductibleType?: string | null;
  deductibleAmount?: number | null;
  blanketNumber?: string | null;
  causeOfLoss?: string | null;
  formsConditions?: string | null;
  otherOccupancies?: string | null;
  historicalLandmark?: boolean | null;
  sinkholeCoverageAccepted?: boolean | null;
  mineSubsidenceCoverage?: boolean | null;
  remarks?: string | null;
}

interface BlanketInfo {
  blanketNumber?: string | null;
  amount?: number | null;
  type?: string | null;
}

/**
 * The ACORD 140 describes **two buildings per PDF**, so an account with N
 * buildings needs `ceil(N / 2)` of them.
 *
 * The suffixes are the trap in this form and the reason this is a table
 * rather than an interpolated letter. Nothing lines up:
 *
 *  - the per-building fields use `_A` and `_B`;
 *  - the subject-of-insurance rows run `_A.._E` and `_G.._K` — there is no
 *    `_F`, and this mapping fills the first row of each run;
 *  - the premises remark is `_A` and `_C`.
 *
 * See docs/acord/acord-140-fields.txt.
 */
export const BUILDING_BLOCKS = [
  { fields: "A", subject: "A", remark: "A" },
  { fields: "B", subject: "G", remark: "C" },
] as const;

/**
 * The subject-of-insurance runs each block's rows are drawn from.
 *
 * Named so the table above can be checked structurally rather than only by
 * whether its names exist. That distinction is the whole point here: the
 * second block's first row is `_G`, and writing `_B` instead would name a
 * field that **does exist** — it is the second row of the *first* block — so
 * an existence check passes while the form comes out with two rows of one
 * building's coverage and none of the other's.
 */
export const SUBJECT_ROW_RUNS = [
  ["A", "B", "C", "D", "E"],
  ["G", "H", "I", "J", "K"],
] as const;

/** How many buildings one ACORD 140 can describe. */
export const BUILDINGS_PER_140 = BUILDING_BLOCKS.length;

/** The 140's blanket summary has four rows. */
const BLANKET_SUMMARY_ROWS = ["A", "B", "C", "D"] as const;

/**
 * Buildings → one group per PDF. An account with no buildings still gets one
 * page, so the form carries the account's own address and the blanket summary
 * rather than generating nothing.
 */
export function buildingPages<T>(buildings: T[]): T[][] {
  if (buildings.length === 0) return [[]];
  const pages: T[][] = [];
  for (let i = 0; i < buildings.length; i += BUILDINGS_PER_140) {
    pages.push(buildings.slice(i, i + BUILDINGS_PER_140));
  }
  return pages;
}

/**
 * The value that appears most often across the buildings, for the fields the
 * 125 asks once about a site the 140 describes building by building.
 *
 * Ties break toward the first in read order rather than arbitrarily, so the
 * same set of buildings always produces the same sentence.
 */
function mostCommon<T>(values: (T | null | undefined)[]): T | undefined {
  const counts = new Map<T, number>();
  for (const v of values) {
    if (v == null) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best: T | undefined;
  let bestCount = 0;
  for (const [v, n] of counts) {
    if (n > bestCount) {
      best = v;
      bestCount = n;
    }
  }
  return best;
}

type ContactInfo = ContactLike;

/** The slice of the GL application the 125 reads. */
interface GlInfo {
  fullTimeEmployees?: number | null;
  partTimeEmployees?: number | null;
}

interface PriorCarrierInfo {
  carrierName?: string | null;
  policyNumber?: string | null;
  lineOfBusiness?: string | null;
  premium?: number | null;
  effectiveDate?: string | null;
  expirationDate?: string | null;
}

/**
 * CRM line of business → its ACORD 125 checkbox.
 *
 * Every name here exists on the agency's template
 * (`docs/acord/acord-125-fields.txt`). Four lines the CRM tracks have **no
 * box on this form at all** — Workers Comp, Flood, Earthquake and D&O — and
 * are deliberately absent so they fall through to the Other rows below.
 * Listing them with invented names, which is what this table did before the
 * inventory was read, was worse than useless: the line was neither ticked in
 * its own box (the name matched nothing) nor written into an Other row (the
 * table claimed to handle it), so an HOA's D&O simply vanished from the form.
 */
export const LOB_FIELDS: Record<string, readonly string[]> = {
  Property: ["Policy_LineOfBusiness_CommercialProperty_A"],
  "General Liability": ["Policy_LineOfBusiness_CommercialGeneralLiability_A"],
  "Crime/Fidelity": ["Policy_LineOfBusiness_CrimeIndicator_A"],
  Umbrella: ["Policy_LineOfBusiness_UmbrellaIndicator_A"],
};

/** The 125 has six free-text "other line of business" rows. */
const LOB_OTHER_ROWS = ["A", "B", "C", "D", "E", "F"] as const;

/**
 * The prior-coverage section is a **three-year grid**, not a list of lines.
 *
 * Each block (`_A`, `_B`, `_C`) carries a policy year and four fixed rows:
 * general liability, automobile, property, and one catch-all "other line"
 * whose own line is named in a code field. That shape was the surprise in the
 * field inventory — W3 shipped assuming a row per line, with six invented
 * prefixes, four of which named nothing.
 *
 * Automobile has a row here that nothing fills: `LINES_OF_BUSINESS` has no
 * auto line, because this agency does not write it.
 */
const PRIOR_COVERAGE_BLOCKS = ["A", "B", "C"] as const;

/** Lines with a row of their own inside a block. Everything else shares one. */
export const PRIOR_COVERAGE_LINE_ROWS: Record<string, string> = {
  "General Liability": "GeneralLiability",
  Property: "Property",
};

/** One policy year of the prior-coverage grid. */
export interface PriorCoverageBlock {
  /** The year as the form prints it, or "" when no row in it carries a date. */
  year: string;
  generalLiability?: PriorCarrierInfo;
  property?: PriorCarrierInfo;
  /** The one non-GL, non-property line that fits. */
  other?: PriorCarrierInfo;
}

/**
 * Prior-carrier rows → up to three policy-year blocks, newest first.
 *
 * Grouped by the year the term started, because that is what
 * `PriorCoverage_PolicyYear_*` asks for and what makes the three blocks read
 * as a history rather than an unordered pile. Rows carrying no dates at all
 * are grouped under a blank year and sorted last, so they take a block only
 * if there is one going spare.
 *
 * What does not fit is dropped rather than crammed in: a fourth year, a
 * second "other" line within a year, an auto policy. The form has three
 * blocks of four rows and there is nowhere else to put them.
 */
export function priorCoverageBlocks(
  rows: PriorCarrierInfo[]
): PriorCoverageBlock[] {
  const yearOf = (r: PriorCarrierInfo) =>
    (r.effectiveDate ?? r.expirationDate ?? "").slice(0, 4);

  const byYear = new Map<string, PriorCarrierInfo[]>();
  for (const r of rows) {
    const y = yearOf(r);
    const held = byYear.get(y);
    if (held) held.push(r);
    else byYear.set(y, [r]);
  }

  return [...byYear.keys()]
    // Newest first; undated last, because a row with a year is more use to an
    // underwriter than one without.
    .sort((a, b) => (a === "" ? 1 : b === "" ? -1 : b.localeCompare(a)))
    .slice(0, PRIOR_COVERAGE_BLOCKS.length)
    .map((year) => {
      const newest = newestPriorByLine(byYear.get(year) ?? []);
      const block: PriorCoverageBlock = { year };
      for (const [line, row] of newest) {
        const named = PRIOR_COVERAGE_LINE_ROWS[line];
        if (named === "GeneralLiability") block.generalLiability = row;
        else if (named === "Property") block.property = row;
        else if (!block.other) block.other = row;
      }
      return block;
    });
}

/**
 * The most recent prior policy per line within a set of rows.
 *
 * Ordered on expiration, falling back to the term start, because a row
 * entered off a declarations page that never stated an end date still knows
 * when it began. A row with neither loses to any row that has one.
 */
export function newestPriorByLine<T extends PriorCarrierInfo>(
  rows: T[]
): Map<string, T> {
  const when = (r: T) => r.expirationDate ?? r.effectiveDate ?? "";
  const out = new Map<string, T>();
  for (const r of rows) {
    const line = r.lineOfBusiness;
    if (!line) continue;
    const held = out.get(line);
    if (!held || when(r) > when(held)) out.set(line, r);
  }
  return out;
}

/**
 * Which Legal Entity box the 125 ticks for an account, or `null` for none.
 *
 * Exported for its test. The fallback is the whole of it: before
 * `legalEntityType` existed this block ticked Not-For-Profit for every
 * ASSOCIATION and nothing for anyone else, and every account in the system
 * predates the column. Without the fallback, W2 would ship as a silent
 * *un*ticking of a box on every existing association's next carrier
 * submission — a regression wearing a new feature's clothes.
 *
 * A stated type always wins, including on an association: an HOA that is
 * actually incorporated says so, and the fallback is a guess standing in for
 * an unanswered question, not a fact about the account.
 */
export function legalEntityFor(account: {
  legalEntityType?: LegalEntityType | null;
  type?: string | null;
}): LegalEntityType | null {
  if (account.legalEntityType) return account.legalEntityType;
  return account.type === "ASSOCIATION" ? DEFAULT_ASSOCIATION_LEGAL_ENTITY : null;
}

/** ACORD 125 has four premises rows on the form; the rest go on a schedule. */
const PREMISES_ROWS = ["A", "B", "C", "D"] as const;

const STOREY_WORD: Record<number, string> = {
  1: "one-story",
  2: "two-story",
  3: "three-story",
  4: "four-story",
};

/**
 * Underwriters read this line first. Build it from what the CRM knows —
 * "52-unit residential condominium association consisting of 13 two-story
 * wood-frame buildings constructed 2016-2017" — rather than emitting a
 * generic label that tells them nothing.
 */
export function operationsSummary(
  account: Pick<Account, "type" | "unitCount">,
  buildings: BuildingInfo[]
): string {
  if (account.type !== "ASSOCIATION") return "";
  const bits: string[] = [];
  bits.push(
    account.unitCount
      ? `${account.unitCount}-unit residential condominium association`
      : "Residential condominium association"
  );
  // Storeys, construction and the build year now come from the buildings
  // rather than from three Account columns that could describe one building.
  // The most common value across the rows: a site with a 1978 clubhouse and
  // twelve 2016 townhouses is a 2016 site with an old clubhouse, and saying
  // "constructed 1978" of it would be the wrong headline.
  const storeys = mostCommon(buildings.map((b) => b.stories));
  const construction = mostCommon(buildings.map((b) => b.constructionType));
  const built = mostCommon(buildings.map((b) => b.yearBuilt));
  const shape = [
    storeys ? STOREY_WORD[storeys] ?? `${storeys}-story` : "",
    construction ? CONSTRUCTION_PHRASES[construction] ?? "" : "",
  ]
    .filter(Boolean)
    .join(" ");
  if (buildings.length > 0) {
    bits.push(
      `consisting of ${buildings.length} ${shape ? shape + " " : ""}building${
        buildings.length === 1 ? "" : "s"
      }`
    );
  } else if (shape) {
    bits.push(`${shape} construction`);
  }
  if (built) bits.push(`constructed ${built}`);
  return bits.join(" ") + ".";
}

/**
 * Registry keys buildAppFormValues actually has a mapping branch for. Every
 * other entry would generate with nothing but the shared header, so the UI
 * keeps its Generate button off. Add a key here when you add its branch.
 */
export const MAPPED_APP_FORM_KEYS = new Set(["acord125", "acord140"]);

/**
 * Shared applicant/producer values for the application-section forms.
 * The producer/insured blocks follow the same eForm naming convention as
 * the ACORD 25, so they're high-confidence; form-specific fields carry
 * best-effort candidates — refine them via Settings → Inspect fields
 * exactly like the 25 (misses are reported after each generation).
 */
function buildAppFormValues(
  formKey: string,
  account: Account,
  buildings: BuildingInfo[],
  contacts: ContactInfo[],
  priorCarriers: PriorCarrierInfo[],
  /** The account's blanket schedule — the 140's summary rows. */
  blankets: BlanketInfo[],
  /** The account's GL application, when it has one. */
  gl: GlInfo | null,
  /**
   * When the coverage being applied for starts. For a lead that's the
   * incumbent's expiration; for a client it's the expiring policy's end date
   * — `currentPolicyExpiration` is a lead-only field and is meaningless once
   * bound policies exist.
   */
  renewalDate?: string | null,
  /** Lines being applied for — ticks the line-of-business boxes. */
  lines: string[] = []
): FieldValues {
  const totalSqft = buildings.reduce((s, b) => s + (b.sqft ?? 0), 0);
  const primary = primaryContact(contacts);
  const newestByLine = newestPriorByLine(priorCarriers);

  const zip = account.zip ?? "";
  const state = account.state ?? "";
  const city = account.city ?? "";
  const addr = account.address ?? "";

  // ── Shared header ──
  // Every ACORD eForm uses this naming convention, so this block applies to
  // all of them. Candidates with no matching field are skipped and reported,
  // so listing a field a given form lacks costs nothing.
  const legalName = account.legalName?.trim() || account.name;
  const proposedEff =
    renewalDate ??
    (account.stage === "CLIENT" ? "" : account.currentPolicyExpiration ?? "");

  const values: FieldValues = {
    date: {
      candidates: ["Form_CompletionDate_A"],
      value: todayUs(),
    },

    producer: { candidates: ["Producer_FullName_A"], value: AGENCY.name },
    producerContact: {
      candidates: ["Producer_ContactPerson_FullName_A"],
      value: AGENCY.contactName,
    },
    producerAddr1: { candidates: ["Producer_MailingAddress_LineOne_A"], value: AGENCY.addressLine1 },
    producerCity: { candidates: ["Producer_MailingAddress_CityName_A"], value: AGENCY.city },
    producerState: { candidates: ["Producer_MailingAddress_StateOrProvinceCode_A"], value: AGENCY.state },
    producerZip: { candidates: ["Producer_MailingAddress_PostalCode_A"], value: AGENCY.zip },
    producerPhone: { candidates: ["Producer_ContactPerson_PhoneNumber_A"], value: AGENCY.phone },
    producerEmail: { candidates: ["Producer_ContactPerson_EmailAddress_A"], value: AGENCY.email },

    // Carriers match submissions on the legal entity, not the short name.
    insured: { candidates: ["NamedInsured_FullName_A"], value: legalName },
    insuredAddr1: { candidates: ["NamedInsured_MailingAddress_LineOne_A"], value: account.address ?? "" },
    insuredCity: { candidates: ["NamedInsured_MailingAddress_CityName_A"], value: account.city ?? "" },
    insuredState: { candidates: ["NamedInsured_MailingAddress_StateOrProvinceCode_A"], value: account.state ?? "" },
    insuredZip: { candidates: ["NamedInsured_MailingAddress_PostalCode_A"], value: account.zip ?? "" },
    insuredPhone: {
      candidates: ["NamedInsured_Primary_PhoneNumber_A"],
      value: primary?.phone ?? "",
    },
    insuredFein: { candidates: ["NamedInsured_TaxIdentifier_A"], value: account.fein ?? "" },
    insuredSic: { candidates: ["NamedInsured_SICCode_A"], value: account.sicCode ?? "" },
    insuredNaics: { candidates: ["NamedInsured_NAICSCode_A"], value: account.naicsCode ?? "" },

    policyEffective: { candidates: ["Policy_EffectiveDate_A"], value: fmtUs(proposedEff) },
    carrierName: {
      // Left blank: the carrier is chosen per submission, not per account.
      candidates: ["Insurer_FullName_A"],
      value: "",
    },
  };

  if (formKey === "acord125") {
    // Commercial Insurance Application — producer, applicant, premises.
    // A renewal submission is proposed to start when the current term ends.
    const proposedExp = proposedEff
      ? (() => {
          const d = new Date(proposedEff + "T00:00:00");
          d.setFullYear(d.getFullYear() + 1);
          return d.toISOString().slice(0, 10);
        })()
      : "";
    const inspection = inspectionContact(contacts);
    const legalEntity = legalEntityFor(account);

    Object.assign(values, {
      // The Legal Entity box, through the one table that also builds the
      // dropdown. This used to tick Not-For-Profit for every ASSOCIATION and
      // nothing at all for anyone else, which is why an unset column still
      // falls back to exactly that — every account in the system predates
      // `legalEntityType`, and shipping this without the fallback would
      // untick a box on their next submission.
      legalEntity: {
        candidates: legalEntity ? [...ACORD125_LEGAL_ENTITY_FIELDS[legalEntity]] : [],
        value: legalEntity ? "x" : "",
      },
      condoType: {
        candidates: ["BusinessInformation_BusinessType_CondominiumsIndicator_A"],
        value: account.type === "ASSOCIATION" ? "x" : "",
      },

      // Revenue is asked per premises on this form
      // (`CommercialStructure_AnnualRevenueAmount_A..D`), not once for the
      // business. An association's dues income is an account-level figure, so
      // it goes against the first premises row only — stating it four times
      // would read as four times the revenue.
      annualRevenue: {
        candidates: ["CommercialStructure_AnnualRevenueAmount_A"],
        value: account.annualRevenue != null ? account.annualRevenue.toFixed(0) : "",
      },
      // Asked per premises like the revenue above, and answered once for the
      // association: the GL application is where the agency records staff
      // counts, and an HOA's are site-wide rather than per building.
      fullTimeEmployees: {
        candidates: ["BusinessInformation_FullTimeEmployeeCount_A"],
        value: gl?.fullTimeEmployees != null ? String(gl.fullTimeEmployees) : "",
      },
      partTimeEmployees: {
        candidates: ["BusinessInformation_PartTimeEmployeeCount_A"],
        value: gl?.partTimeEmployees != null ? String(gl.partTimeEmployees) : "",
      },

      proposedEffective: { candidates: ["Policy_EffectiveDate_A"], value: fmtUs(proposedEff) },
      proposedExpiration: { candidates: ["Policy_ExpirationDate_A"], value: fmtUs(proposedExp) },

      // Who the carrier's inspector calls to get on site — the first contact
      // carrying the INSPECTION role, where this used to be two Account
      // columns that could name exactly one person and never said who the
      // other five were. The description text comes from the same label table
      // the role dropdown renders, so the PDF and the form cannot disagree
      // about what the role is called.
      inspectionLabel: {
        candidates: ["NamedInsured_Contact_ContactDescription_A"],
        value: inspection ? CONTACT_TYPE_LABELS.INSPECTION : "",
      },
      inspectionName: {
        candidates: ["NamedInsured_Contact_FullName_A"],
        value: inspection?.name ?? "",
      },
      inspectionPhone: {
        candidates: ["NamedInsured_Contact_PrimaryPhoneNumber_A"],
        value: inspection?.phone ?? "",
      },

      natureOfBusiness: {
        candidates: [
          "CommercialPolicy_OperationsDescription_A",
          "BuildingOccupancy_OperationsDescription_A",
        ],
        value: operationsSummary(account, buildings),
      },
    } satisfies FieldValues);

    // ── Incumbent coverage: three policy-year blocks ──
    //
    // This used to fill a single General Liability row from five Account
    // columns, so an association carrying property with one carrier and GL
    // with another could only ever declare one of them. The form actually
    // offers three years, each with a GL row, a property row and one
    // catch-all — see `priorCoverageBlocks`.
    priorCoverageBlocks(priorCarriers).forEach((blk, i) => {
      const b = PRIOR_COVERAGE_BLOCKS[i];
      values[`priorYear${b}`] = {
        candidates: [`PriorCoverage_PolicyYear_${b}`],
        value: blk.year,
      };
      const fillRow = (token: string, tag: string, row?: PriorCarrierInfo) => {
        if (!row) return;
        const at = (suffix: string) => [`PriorCoverage_${token}_${suffix}_${b}`];
        Object.assign(values, {
          [`prior${tag}Carrier${b}`]: {
            candidates: at("InsurerFullName"),
            value: row.carrierName ?? "",
          },
          [`prior${tag}PolicyNumber${b}`]: {
            candidates: at("PolicyNumberIdentifier"),
            value: row.policyNumber ?? "",
          },
          [`prior${tag}Premium${b}`]: {
            candidates: at("TotalPremiumAmount"),
            value: row.premium != null ? row.premium.toFixed(2) : "",
          },
          [`prior${tag}Effective${b}`]: {
            candidates: at("EffectiveDate"),
            value: fmtUs(row.effectiveDate),
          },
          [`prior${tag}Expiration${b}`]: {
            candidates: at("ExpirationDate"),
            value: fmtUs(row.expirationDate),
          },
        } satisfies FieldValues);
      };
      fillRow("GeneralLiability", "GL", blk.generalLiability);
      fillRow("Property", "Property", blk.property);
      fillRow("OtherLine", "Other", blk.other);
      // The field naming that "other" line exists on the first block only —
      // an omission in the form, not in this mapping. Blocks B and C print
      // the carrier and the dates with no label saying what line they are.
      if (b === "A" && blk.other) {
        values.priorOtherLineCode = {
          candidates: ["PriorCoverage_OtherLine_LineOfBusinessCode_A"],
          value: blk.other.lineOfBusiness ?? "",
        };
      }
    });

    // ── Lines of business ──
    for (const line of lines) {
      const candidates = LOB_FIELDS[line];
      if (!candidates) continue;
      values[`lob_${line.replace(/\W+/g, "")}`] = {
        candidates: [...candidates],
        value: "x",
      };
    }
    // Anything without a box of its own gets one of the six Other rows, named
    // individually. Joining them into a single row — which is what this did
    // before — put "Workers Comp, Flood, D&O" on one line of a form that has
    // six lines and a premium column beside each.
    lines
      .filter((l) => !LOB_FIELDS[l])
      .slice(0, LOB_OTHER_ROWS.length)
      .forEach((line, i) => {
        const row = LOB_OTHER_ROWS[i];
        values[`lobOther${row}`] = {
          candidates: [`Policy_LineOfBusiness_OtherIndicator_${row}`],
          value: "x",
        };
        values[`lobOtherDesc${row}`] = {
          candidates: [`Policy_LineOfBusiness_OtherLineOfBusinessDescription_${row}`],
          value: line,
        };
      });

    // ── Policy information ──
    // A carrier submission is a request to quote, not an issued policy.
    Object.assign(values, {
      policyStatusQuote: {
        candidates: ["Policy_Status_QuoteIndicator_A"],
        value: "x",
      },
      policyNumber: {
        candidates: ["Policy_PolicyNumberIdentifier_A"],
        // New business has no number yet; a renewal carries the incumbent's.
        // Which incumbent, now that there can be several: the one covering
        // the first line being applied for that has a prior policy at all.
        // `lines` is ordered by the caller, so this is "the main thing this
        // submission is about" rather than an arbitrary pick — and blank when
        // nothing lines up, which is what the field means for new business.
        value:
          lines
            .map((l) => newestByLine.get(l)?.policyNumber)
            .find((n) => n) ?? "",
      },
      billingPlanDirect: {
        candidates: ["Policy_Payment_DirectBillIndicator_A"],
        value: "x",
      },
    } satisfies FieldValues);

    // ── Attachments ──
    //
    // Three mappings used to live here and none of them named a field that
    // exists on this form: an "additional remarks schedule" box, and a
    // "section attached" box per line. The attachment list on the 125 is a
    // fixed set of named supplements (statement of values, condominium
    // by-laws, loss summary…) with no per-line entry and no remarks entry —
    // the line-of-business checkboxes above already say which sections a
    // submission covers, so the per-line boxes were saying it twice and
    // saying it to nothing.
    //
    // The form does carry `CommercialPolicy_RemarkText_A`, a free-text
    // remarks field. `account.notes` is deliberately NOT written into it:
    // those notes are internal, they are not composed for a carrier's eyes,
    // and putting them on a submission is a decision for the agency to make
    // rather than one to inherit from a dead checkbox.

    // ── Premises schedule ──
    // One row per building. Falls back to the account address when no
    // buildings are recorded, which is what the old mapping always did.
    const premises = buildings.length
      ? buildings
      : [{ streetAddress: addr, sqft: totalSqft || null, description: null }];

    premises.slice(0, PREMISES_ROWS.length).forEach((b, i) => {
      const row = PREMISES_ROWS[i];
      const line1 = b.streetAddress?.trim() || b.label?.trim() || addr;
      Object.assign(values, {
        [`premisesNum${row}`]: {
          candidates: [`CommercialStructure_Location_ProducerIdentifier_${row}`],
          value: String(i + 1),
        },
        [`premisesAddr${row}`]: {
          candidates: [`CommercialStructure_PhysicalAddress_LineOne_${row}`],
          value: line1,
        },
        [`premisesCity${row}`]: {
          candidates: [`CommercialStructure_PhysicalAddress_CityName_${row}`],
          value: city,
        },
        [`premisesCounty${row}`]: {
          candidates: [`CommercialStructure_PhysicalAddress_CountyName_${row}`],
          value: account.county ?? "",
        },
        [`premisesState${row}`]: {
          candidates: [`CommercialStructure_PhysicalAddress_StateOrProvinceCode_${row}`],
          value: state,
        },
        [`premisesZip${row}`]: {
          candidates: [`CommercialStructure_PhysicalAddress_PostalCode_${row}`],
          value: zip,
        },
        [`premisesArea${row}`]: {
          candidates: [`Construction_BuildingArea_${row}`],
          value: b.sqft != null ? String(b.sqft) : "",
        },
        // An association owns its buildings and sits inside town limits.
        [`premisesOwner${row}`]: {
          candidates: [`CommercialStructure_InsuredInterest_OwnerIndicator_${row}`],
          value: account.type === "ASSOCIATION" ? "x" : "",
        },
        [`premisesInCity${row}`]: {
          candidates: [`CommercialStructure_RiskLocation_InsideCityLimitsIndicator_${row}`],
          value: "x",
        },
        [`premisesDesc${row}`]: {
          candidates: [`BuildingOccupancy_OperationsDescription_${row}`],
          value: b.description?.trim() || "",
        },
      } satisfies FieldValues);
    });

    // More buildings than the form has rows — flag the attachment so the
    // underwriter knows a schedule follows rather than assuming four.
    if (buildings.length > PREMISES_ROWS.length) {
      values.additionalPremises = {
        candidates: ["CommercialPolicy_Attachment_AdditionalPremisesScheduleIndicator_A"],
        value: "x",
      };
    }
  }

  if (formKey === "acord126") {
    // GL section — only the header maps from account data; GL limits are
    // entered per submission. Named insured / producer / effective already set.
  }

  if (formKey === "acord140") {
    // ── Property section: two buildings per PDF ──
    //
    // This used to fill one building block from Account columns — a single
    // yearBuilt, a single roof year, one construction class for a site with a
    // 1978 clubhouse and 2016 townhouses. `buildings` here is one page's
    // worth; `buildingPages` decides what a page is and `FormsTab` loops.

    // Blanket summary, at the top of the form and about the account rather
    // than either building on this page. Repeated on every page of a
    // multi-page set, which is what an underwriter reading page 3 needs.
    blankets.slice(0, BLANKET_SUMMARY_ROWS.length).forEach((bl, i) => {
      const row = BLANKET_SUMMARY_ROWS[i];
      Object.assign(values, {
        [`blanketNumber${row}`]: {
          candidates: [`CommercialProperty_Summary_BlanketNumberIdentifier_${row}`],
          value: bl.blanketNumber ?? "",
        },
        [`blanketLimit${row}`]: {
          candidates: [`CommercialProperty_Summary_BlanketLimitAmount_${row}`],
          value: bl.amount != null ? Math.round(bl.amount).toString() : "",
        },
        [`blanketType${row}`]: {
          candidates: [`CommercialCoverage_Summary_BlanketTypeDescription_${row}`],
          value: bl.type ?? "",
        },
      } satisfies FieldValues);
    });

    buildings.slice(0, BUILDINGS_PER_140).forEach((b, i) => {
      const { fields: F, subject: S, remark: R } = BUILDING_BLOCKS[i];
      const n = (v: number | null | undefined) => (v != null ? String(v) : "");
      const money = (v: number | null | undefined) =>
        v != null ? Math.round(v).toString() : "";
      /** A nullable boolean as the form's Yes/No indicator pair. */
      const yesNo = (v: boolean | null | undefined, yes: string, no: string) => ({
        [`${yes.replace(/\W+/g, "")}${F}`]: {
          candidates: [yes],
          value: v === true ? "x" : "",
        },
        [`${no.replace(/\W+/g, "")}${F}`]: {
          candidates: [no],
          value: v === false ? "x" : "",
        },
      });
      /** A system-improvement year and the "was improved" box beside it. */
      const improvement = (kind: string, year: number | null | undefined) => ({
        [`${kind}Year${F}`]: {
          candidates: [`BuildingImprovement_${kind}Year_${F}`],
          value: n(year),
        },
        [`${kind}Ind${F}`]: {
          candidates: [`BuildingImprovement_${kind}Indicator_${F}`],
          value: year ? "x" : "",
        },
      });

      Object.assign(values, {
        [`premisesNumber${F}`]: {
          candidates: [`CommercialStructure_Location_ProducerIdentifier_${F}`],
          value: String(i + 1),
        },
        [`buildingNumber${F}`]: {
          candidates: [`CommercialStructure_Building_ProducerIdentifier_${F}`],
          value: String(i + 1),
        },
        [`buildingAddr${F}`]: {
          candidates: [`CommercialStructure_PhysicalAddress_LineOne_${F}`],
          value: b.streetAddress?.trim() || addr,
        },
        [`buildingLabel${F}`]: {
          candidates: [`CommercialStructure_Building_SublocationDescription_${F}`],
          value: b.label ?? "",
        },

        // ── Construction ──
        [`constructionCode${F}`]: {
          candidates: [`Construction_ConstructionCode_${F}`],
          value: b.constructionType ? CONSTRUCTION_LABELS[b.constructionType] ?? "" : "",
        },
        [`stories${F}`]: {
          candidates: [`Construction_StoreyCount_${F}`],
          value: n(b.stories),
        },
        [`basements${F}`]: {
          candidates: [`Construction_BasementCount_${F}`],
          value: n(b.basements),
        },
        [`builtYear${F}`]: {
          candidates: [`CommercialStructure_BuiltYear_${F}`],
          value: n(b.yearBuilt),
        },
        [`buildingArea${F}`]: {
          candidates: [`Construction_BuildingArea_${F}`],
          value: n(b.sqft),
        },
        [`roofMaterial${F}`]: {
          candidates: [`Construction_RoofMaterialCode_${F}`],
          value: b.roofType ?? "",
        },
        ...improvement("Roofing", b.roofYear),
        ...improvement("Heating", b.heatingYear),
        ...improvement("Wiring", b.wiringYear),
        ...improvement("Plumbing", b.plumbingYear),

        // ── Protection ──
        [`hydrantDistance${F}`]: {
          candidates: [`BuildingFireProtection_HydrantDistanceFeetCount_${F}`],
          value: n(b.distanceToHydrantFt),
        },
        [`fireStationDistance${F}`]: {
          candidates: [`BuildingFireProtection_FireStationDistanceMileCount_${F}`],
          value: n(b.distanceToFireStationMi),
        },
        // Site-level on the Account, per building on the form — every
        // building on one site is in the same district.
        [`fireDistrict${F}`]: {
          candidates: [`BuildingFireProtection_FireDistrictName_${F}`],
          value: account.fireDistrict ?? "",
        },
        [`fireProtection${F}`]: {
          candidates: [`BuildingFireProtection_Alarm_ProtectionDescription_${F}`],
          value: b.fireProtectionType ?? "",
        },
        [`sprinklerPct${F}`]: {
          candidates: [`BuildingFireProtection_Alarm_SprinklerPercent_${F}`],
          value: n(b.sprinklerPct),
        },

        // ── Coverage: the first subject-of-insurance row of this block ──
        [`subjectCode${S}`]: {
          candidates: [`CommercialProperty_Premises_SubjectOfInsuranceCode_${S}`],
          value: b.individualBuildingValue != null ? "Building" : "",
        },
        [`subjectLimit${S}`]: {
          candidates: [`CommercialProperty_Premises_LimitAmount_${S}`],
          value: money(b.individualBuildingValue),
        },
        [`subjectCoinsurance${S}`]: {
          candidates: [`CommercialProperty_Premises_CoinsurancePercent_${S}`],
          value: n(b.coinsurancePct),
        },
        // Text fields, and the inventory names them without saying what code
        // vocabulary they take — so these write the label rather than an
        // invented code. An underwriter reads this row.
        [`subjectValuation${S}`]: {
          candidates: [`CommercialProperty_Premises_ValuationCode_${S}`],
          value: b.valuation ? REPLACEMENT_COST_CODES[b.valuation] ?? "" : "",
        },
        [`subjectCauseOfLoss${S}`]: {
          candidates: [`CommercialProperty_Premises_CauseOfLossCode_${S}`],
          value: b.causeOfLoss ? CAUSE_OF_LOSS_LABELS[b.causeOfLoss] ?? "" : "",
        },
        [`subjectDeductible${S}`]: {
          candidates: [`CommercialProperty_Premises_DeductibleAmount_${S}`],
          value: money(b.deductibleAmount),
        },
        [`subjectDeductibleType${S}`]: {
          candidates: [`CommercialProperty_Premises_DeductibleTypeCode_${S}`],
          value: b.deductibleType
            ? BUILDING_DEDUCTIBLE_TYPE_LABELS[b.deductibleType] ?? ""
            : "",
        },
        [`subjectBlanket${S}`]: {
          candidates: [`CommercialProperty_Premises_BlanketNumber_${S}`],
          value: b.blanketNumber ?? "",
        },
        [`subjectForms${S}`]: {
          candidates: [`CommercialProperty_Premises_FormsAndConditions_${S}`],
          value: b.formsConditions ?? "",
        },

        // ── Other ──
        [`otherOccupancies${F}`]: {
          candidates: [`BuildingOccupancy_OtherOccupanciesDescription_${F}`],
          value: b.otherOccupancies ?? "",
        },
        [`historicalLandmark${F}`]: {
          candidates: [`BuildingFeatures_HistoricalPropertyIndicator_${F}`],
          value: b.historicalLandmark ? "x" : "",
        },
        ...yesNo(
          b.sinkholeCoverageAccepted,
          `CommercialPropertyCoverage_SinkHoleCollapse_YesIndicator_${F}`,
          `CommercialPropertyCoverage_SinkHoleCollapse_NoIndicator_${F}`
        ),
        ...yesNo(
          b.mineSubsidenceCoverage,
          `CommercialPropertyCoverage_MineSubsidence_YesIndicator_${F}`,
          `CommercialPropertyCoverage_MineSubsidenceOption_NoIndicator_${F}`
        ),
        // The remark suffix is the one that does not follow the block letter.
        [`remarks${R}`]: {
          candidates: [`CommercialProperty_Premises_RemarkText_${R}`],
          value: b.remarks ?? "",
        },
      } satisfies FieldValues);
    });
  }

  return values;
}

export async function fillAcordApp(
  form: AcordFormDef,
  account: Account,
  buildings: BuildingInfo[],
  contacts: ContactInfo[],
  priorCarriers: PriorCarrierInfo[],
  blankets: BlanketInfo[],
  gl: GlInfo | null,
  signature?: SignatureInfo | null,
  renewalDate?: string | null,
  lines: string[] = []
): Promise<FillResult> {
  return fillTemplate(
    form.path,
    buildAppFormValues(
      form.key,
      account,
      buildings,
      contacts,
      priorCarriers,
      blankets,
      gl,
      renewalDate,
      lines
    ),
    signature
  );
}
