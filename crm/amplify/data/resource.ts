import { type ClientSchema, a, defineData } from "@aws-amplify/backend";
import { processDocument } from "../functions/process-document/resource";
import { leadIntake } from "../functions/lead-intake/resource";
import { teamAdmin } from "../functions/team-admin/resource";
import { extractLead } from "../functions/extract-lead/resource";
import { formFiller } from "../functions/form-filler/resource";
import { certNumber } from "../functions/cert-number/resource";
import { renewalTasks } from "../functions/renewal-tasks/resource";
import { licenseAlerts } from "../functions/license-alerts/resource";
import { taskDigest } from "../functions/task-digest/resource";
import { activityLog } from "../functions/activity-log/resource";

/**
 * HOA CRM data model.
 *
 * Lifecycle: an Account starts as stage=LEAD. Binding (accepting) a Quote
 * creates a Policy and flips the Account to stage=CLIENT in place — this is
 * the only path to Client, and it preserves all documents/quotes/history
 * without re-linking.
 *
 * "CarrierAppointment" here means an agency appointment with a carrier
 * (authority to write), not a calendar appointment.
 */
const schema = a
  .schema({
    // ── Lifecycle enums ────────────────────────────────────────────────
    AccountStage: a.enum(["LEAD", "CLIENT"]),
    AccountType: a.enum(["ASSOCIATION", "PERSONAL", "COMMERCIAL_OTHER"]),
    QuoteStatus: a.enum([
      "DRAFT",
      "SUBMITTED",
      "QUOTED",
      "PRESENTED",
      "BOUND",
      "DECLINED",
      "LOST",
    ]),
    PolicyStatus: a.enum(["ACTIVE", "EXPIRED", "CANCELLED", "NON_RENEWED"]),
    DocumentEntityType: a.enum([
      "ACCOUNT",
      "QUOTE",
      "POLICY",
      "CARRIER",
      "CERTIFICATE",
      "USER_PROFILE",
      "LICENSE",
    ]),
    DocumentCategory: a.enum([
      "PRIOR_POLICY",
      "CONDO_DOCS",
      "BUDGET",
      "DUES_SCHEDULE",
      "LOSS_RUNS",
      "QUOTE_DOC",
      "POLICY_DOC",
      "LICENSE",
      "ACORD_FORM", // generated carrier-submission forms
      "OTHER",
    ]),
    OcrStatus: a.enum(["PENDING", "PROCESSING", "COMPLETE", "FAILED", "SKIPPED"]),
    ExtractionStatus: a.enum(["PENDING", "PROCESSING", "COMPLETE", "FAILED"]),
    UserRole: a.enum(["ADMIN", "STAFF", "PRODUCER"]),
    // ── Renewal marketing tasks ──
    MarketingTaskStatus: a.enum(["OPEN", "COMPLETE"]),
    // The only two ways a marketing task can be satisfied.
    /**
     * How a closed marketing task ended.
     *
     * `OUT_OF_APPETITE` means *carrier* appetite and is labelled that way in
     * the app. The member keeps its original name because it is the value
     * already written on live rows: an enum member removed here is a value
     * AppSync will not serialise, so renaming it would break every completed
     * task in the list until a migration caught up. Renaming is a three-step
     * change — add, migrate, drop — not a one-line one.
     */
    MarketingTaskResolution: a.enum([
      "QUOTED",
      "OUT_OF_APPETITE",
      "OUT_OF_AGENCY_APPETITE",
      "NOT_SUBMITTED_ON_TIME",
    ]),
    MarketingTaskSource: a.enum(["POLICY", "LEAD"]),
    // ── Licensing ──
    // FIRM  = the agency entity licensed in a state (agency/business entity license)
    // PRODUCER = an individual staff member's personal license
    LicenseHolderType: a.enum(["FIRM", "PRODUCER"]),
    LicenseClass: a.enum([
      "PRODUCER",
      "AGENCY",
      "SURPLUS_LINES",
      "ADJUSTER",
      "CONSULTANT",
    ]),
    // Every licensee has exactly one resident state; the rest are non-resident.
    LicenseResidency: a.enum(["RESIDENT", "NON_RESIDENT"]),
    LicenseStatus: a.enum(["ACTIVE", "PENDING", "INACTIVE", "LAPSED", "EXPIRED"]),
    // ISO construction classes
    ConstructionType: a.enum([
      "FRAME",
      "JOISTED_MASONRY",
      "NON_COMBUSTIBLE",
      "MASONRY_NON_COMBUSTIBLE",
      "MODIFIED_FIRE_RESISTIVE",
      "FIRE_RESISTIVE",
    ]),
    ReplacementCostType: a.enum(["RC", "ERC", "GRC"]),
    // Per-building property terms (ACORD 140 subject-of-insurance row).
    BuildingDeductibleType: a.enum(["PER_OCCURRENCE", "OTHER"]),
    CauseOfLoss: a.enum(["SPECIAL", "BASIC", "BROAD"]),
    AggregateAppliesTo: a.enum(["POLICY", "PROJECT", "LOCATION", "OTHER"]),
    // The ACORD 125 applicant block's "Legal Entity" checkboxes, one member
    // per box. Kept in the schema's order rather than the form's, which puts
    // them in two columns.
    LegalEntityType: a.enum([
      "CORPORATION",
      "INDIVIDUAL",
      "JOINT_VENTURE",
      "LLC",
      "NOT_FOR_PROFIT",
      "PARTNERSHIP",
      "SUBCHAPTER_S_CORP",
      "TRUST",
    ]),
    // ── General liability application (ACORD 126 input) ──
    // What the association carries or is applying for, not what a carrier
    // quoted — Quote/Policy already have their own gl* columns for that.
    GlDeductibleType: a.enum(["PER_OCCURRENCE", "PER_CLAIM"]),
    GlPremiumBasis: a.enum(["UNIT", "OTHER"]),
    // ── Directors & Officers (ACORD 810 input) ──
    DoPart: a.enum(["A", "B", "C"]),
    DoCoverageType: a.enum(["PRIMARY", "EXCESS"]),
    DefenseLimitPosition: a.enum(["INSIDE", "OUTSIDE"]),
    // Roles an association contact plays. The seven named ones are what the
    // agency asked for; OTHER is here because carriers routinely ask for a
    // role the list does not cover — a property manager's assistant, an
    // on-site super — and the alternative to a member for them is a contact
    // recorded with no role at all.
    ActivityAction: a.enum(["CREATE", "UPDATE", "DELETE"]),
    ContactType: a.enum([
      "INSPECTION",
      "CLAIMS",
      "ACCOUNTING",
      "MANAGER",
      "TRUSTEE",
      "DIRECTOR",
      "PRESIDENT",
      "OTHER",
    ]),

    // ── Account: Lead → Client, converted in place ─────────────────────
    //
    // Authenticated read/write, ADMIN-only delete. Deleting an account is the
    // cascade in DeleteLeadZone — it takes the quotes and documents with it —
    // and that was gated in the client only (`if (!isAdmin) return null`),
    // which is not a gate at all as far as the API is concerned.
    //
    // No owner-scoping: no model carries an owning-producer id, so there is
    // nothing to anchor on. Same reasoning as Policy and Certificate.
    //
    // `leadIntake` creates Accounts and `extractLead` updates them, both
    // without an explicit authMode. Neither is affected by this rule — see
    // the note on `allow.resource` at the bottom of this file.
    Account: a
      .model({
        stage: a.ref("AccountStage").required(),
        type: a.ref("AccountType").required(),
        name: a.string().required(), // association / insured name (display)
        // Full legal entity name as it must appear on carrier submissions,
        // e.g. "Freedom Village at the Villages of the Americas Condominium
        // Trust". Falls back to `name` on ACORD forms when empty.
        legalName: a.string(),
        fein: a.string(), // federal tax ID — ACORD 125 applicant block
        sicCode: a.string(), // e.g. 8641
        naicsCode: a.string(), // e.g. 813990
        // How the applicant is organised — ACORD 125's Legal Entity boxes.
        // An association left blank still ticks Not-For-Profit; see
        // DEFAULT_ASSOCIATION_LEGAL_ENTITY in enums.ts.
        legalEntityType: a.ref("LegalEntityType"),
        // Gross annual revenue, for the 125's business-information block.
        annualRevenue: a.float(),
        // ── Contact columns: superseded by the Contact model ──
        // Nothing reads or writes these any more; they are kept only until
        // the backfill has run and been verified, which is the rollback point
        // for W1. See docs/specs/lead-client-expansion.md → Migration and
        // rollout. Removing a field here does not delete the DynamoDB
        // attribute, so this stays reversible until something overwrites it —
        // and nothing does.
        contactFirstName: a.string(),
        contactLastName: a.string(),
        contactEmail: a.email(),
        // Free-form: a.phone() only accepts E.164 and rejects "555-123-4567"
        contactPhone: a.string(),
        contacts: a.hasMany("Contact", "accountId"),
        address: a.string(),
        city: a.string(),
        state: a.string(),
        zip: a.string(),
        county: a.string(), // carriers rate by county; ACORD premises block
        unitCount: a.integer(),
        yearBuilt: a.integer(),
        totalInsuredValue: a.float(),
        // ── Property / underwriting details ──
        constructionType: a.ref("ConstructionType"),
        firewallsVerified: a.boolean(),
        stories: a.integer(),
        coastal: a.boolean(),
        milesToCoast: a.float(), // only meaningful when coastal
        roofUpdatedYear: a.integer(),
        hvacUpdatedYear: a.integer(),
        electricalUpdatedYear: a.integer(),
        plumbingUpdatedYear: a.integer(),
        otherUpdates: a.string(),
        // Which fire district serves the site. Free text: districts are named
        // locally and inconsistently ("Middlesex FD #3", "Town of Acton"),
        // and there is no list to pick from.
        fireDistrict: a.string(),
        blankets: a.hasMany("Blanket", "accountId"),
        losses: a.hasMany("Loss", "accountId"),
        // 1:1. Created lazily, on the first save of either section — an
        // account that has never been asked about GL should not carry an
        // empty row implying it was.
        glApplication: a.hasOne("GlApplication", "accountId"),
        glClassCodes: a.hasMany("GlClassCode", "accountId"),
        doApplication: a.hasOne("DoApplication", "accountId"),
        doCoverageParts: a.hasMany("DoCoveragePart", "accountId"),
        coverPhotoKey: a.string(), // S3 keys under property-photos/
        aerialPhotoKey: a.string(),
        plotPlanKey: a.string(),
        // ── AI document extraction ──
        extractionStatus: a.ref("ExtractionStatus"),
        aiExtraction: a.json(), // per-field values + confidence + evidence
        extractionError: a.string(),
        // The `extractedAt` of the extraction that was last applied — the
        // identity of a result, not the moment somebody pressed the button.
        // That is what answers "has this one already been applied", which is
        // the question W9's idempotency rule asks. A plain string rather than
        // a.datetime() so a malformed value in an old result can never make
        // the whole apply fail on a validation error.
        aiExtractionAppliedAt: a.string(),
        buildings: a.hasMany("Building", "accountId"),
        // Incumbent broker/agent currently servicing the account
        currentAgent: a.string(),
        // Incumbent policy expiration (drives lead renewal pipeline; for
        // clients the bound Policy records are authoritative)
        currentPolicyExpiration: a.date(),
        // Superseded by the INSPECTION-typed Contact; see the note above.
        inspectionContactName: a.string(),
        inspectionContactPhone: a.string(),
        // ── Incumbent coverage: superseded by the PriorCarrier model ──
        // One row's worth of columns for what is genuinely a list — an
        // association carries property, GL, D&O and crime with different
        // carriers on different terms. Unread since W3; kept until the
        // backfill has run, same as the contact columns above.
        priorCarrierName: a.string(),
        priorPolicyNumber: a.string(),
        priorPremium: a.float(),
        priorTermEffective: a.date(),
        priorTermExpiration: a.date(),
        priorCarriers: a.hasMany("PriorCarrier", "accountId"),
        // Write-only by design: set by lead-intake from the web lead forms and
        // never read back in the app. Kept because it is the only link from an
        // account to its Buildium property record.
        buildiumId: a.string(), // lineage from web lead forms / Buildium sync
        source: a.string(), // e.g. "website", "referral", "cold"
        notes: a.string(),
        convertedAt: a.datetime(), // set when first quote is bound
        // Who made this write — see the Contact model's note.
        lastWriteBy: a.string(),
        quotes: a.hasMany("Quote", "accountId"),
        policies: a.hasMany("Policy", "accountId"),
        certificates: a.hasMany("Certificate", "accountId"),
      })
      .secondaryIndexes((index) => [index("stage").sortKeys(["name"])])
      .authorization((allow) => [
        allow.authenticated().to(["read", "create", "update"]),
        allow.groups(["ADMIN"]),
      ]),

    // ── Contacts: the people at an association ─────────────────────────
    //
    // One row per person, replacing the four flat `contact*` columns and the
    // two `inspectionContact*` columns on Account, which between them could
    // hold exactly two people and had no way to say who either of them was.
    //
    // Schema default authorization (authenticated read/write/delete), like
    // Building: adding and removing a contact is ordinary staff work, and no
    // screen gates it on ADMIN — so there is no client gate here for a model
    // rule to have to match.
    //
    // `leadIntake` creates a primary Contact from a web lead. That is not
    // affected by this rule either way — see the note on `allow.resource` at
    // the bottom of this file.
    Contact: a.model({
      accountId: a.id().required(),
      account: a.belongsTo("Account", "accountId"),
      // Who made this write. Set by the actor proxy in `src/lib/client.ts`,
      // read by the activity-log stream handler and then excluded from the
      // diff so it never renders as a change. A write that arrives without
      // one is attributed to "system" — see STREAMED_MODELS in backend.ts.
      lastWriteBy: a.string(),
      name: a.string().required(),
      email: a.email(),
      // Free-form for the same reason Account.contactPhone was: a.phone()
      // accepts only E.164, and these are extensions and 10-digit US numbers.
      phone: a.string(),
      type: a.ref("ContactType"),
      notes: a.string(),
      // Exactly one per account. The ACORD insured block and the COI use this
      // one; without it there is no answer to "which of five contacts is the
      // applicant's phone number".
      isPrimary: a.boolean(),
      // Natural key for the extraction apply path, so re-running an
      // extraction updates the contact it already created instead of adding
      // a second copy of the same person. Also what makes the backfill
      // idempotent. See W9.
      extractionSourceKey: a.string(),
    }),

    // ── Prior coverage: one row per line, per term ─────────────────────
    //
    // Replaces five Account columns that could describe exactly one expiring
    // policy. An association routinely carries property, general liability,
    // D&O and crime with different carriers on different terms, and a renewal
    // submission has to state all of them.
    //
    // Lead-only in the UI (the tab is hidden once an account converts) but
    // NOT deleted on conversion: the rows keep feeding the ACORD 125's prior
    // coverage block on every renewal submission after that.
    //
    // Schema default authorization, like Building and Contact — staff manage
    // these as ordinary work and no screen gates them on ADMIN.
    PriorCarrier: a.model({
      accountId: a.id().required(),
      account: a.belongsTo("Account", "accountId"),
      // Who made this write. Set by the actor proxy in `src/lib/client.ts`,
      // read by the activity-log stream handler and then excluded from the
      // diff so it never renders as a change. A write that arrives without
      // one is attributed to "system" — see STREAMED_MODELS in backend.ts.
      lastWriteBy: a.string(),
      carrierName: a.string(),
      policyNumber: a.string(),
      // A plain string, not an enum: LINES_OF_BUSINESS (client.ts) is a
      // hand-written vocabulary with no schema counterpart, which PATTERNS
      // lists explicitly under "where the rule does not apply". Making it an
      // enum here would create the second copy that rule exists to prevent.
      lineOfBusiness: a.string(),
      premium: a.float(),
      effectiveDate: a.date(),
      expirationDate: a.date(),
      extractionSourceKey: a.string(),
    }),

    // ── Activity: what changed on an account, and who changed it ───────
    //
    // Written only by the activity-log stream handler, which is the system of
    // record for change capture. Read-only from the client: the model rule
    // below denies create/update/delete to a signed-in user, and the handler
    // reaches the API as an IAM principal, which those rules do not apply to
    // (see the note on `allow.resource` at the foot of this file).
    //
    // Not itself streamed, for two reasons: it would loop, and it has no
    // event-source mapping in backend.ts so it cannot.
    Activity: a
      .model({
        // The ACCOUNT id for anything under an account — this is what the tab
        // queries. Mirrors Document's entityId convention.
        entityId: a.string().required(),
        // What actually changed.
        subjectType: a.string().required(), // "Building", "Quote", "Contact", …
        subjectId: a.string().required(),
        subjectLabel: a.string(), // "Building A", "Quote — Travelers"
        action: a.ref("ActivityAction").required(),
        actor: a.string(), // Cognito sub, or "system"
        // Resolved and denormalised at write time, so the tab does not join
        // against UserProfile per row and a renamed user does not rewrite
        // history.
        actorName: a.string(),
        changes: a.json(), // [{ field, from, to }]
        summary: a.string(), // one human sentence
        occurredAt: a.datetime().required(),
      })
      .secondaryIndexes((index) => [index("entityId").sortKeys(["occurredAt"])])
      .authorization((allow) => [
        allow.authenticated().to(["read"]),
        allow.groups(["ADMIN"]),
      ]),

    // ── Loss history ───────────────────────────────────────────────────
    //
    // Kept for leads and clients alike: loss history follows the account, and
    // a renewal submission declares the same losses a new-business one did.
    //
    // `dateOfLoss` and `lineOfBusiness` are required because a loss with
    // neither cannot be placed on the ACORD 125's loss-history rows, which
    // are ordered by date and labelled by line — a row missing either is a
    // row that cannot be submitted.
    Loss: a.model({
      accountId: a.id().required(),
      account: a.belongsTo("Account", "accountId"),
      // Who made this write. Set by the actor proxy in `src/lib/client.ts`,
      // read by the activity-log stream handler and then excluded from the
      // diff so it never renders as a change. A write that arrives without
      // one is attributed to "system" — see STREAMED_MODELS in backend.ts.
      lastWriteBy: a.string(),
      dateOfLoss: a.date().required(),
      // LINES_OF_BUSINESS (client.ts), same reasoning as PriorCarrier's.
      lineOfBusiness: a.string().required(),
      description: a.string(),
      claimDate: a.date(),
      amountPaid: a.float(),
      amountReserved: a.float(),
      claimOpen: a.boolean(),
      amountOfLoss: a.float(),
      typeOfLoss: a.string(),
      extractionSourceKey: a.string(),
    }),

    // ── Blanket coverages ──────────────────────────────────────────────
    //
    // The blanket limits an association's property schedule sits under. Note
    // this is NOT `Quote.blanketLimit` / `Policy.blanketLimit`: those are
    // terms a carrier quoted or bound, and these are the application's own
    // schedule — what the association says it carries. Conflating them would
    // make a quoted limit look like a stated exposure.
    //
    // `type` is free text per the requirement: blanket types are written the
    // way the prior carrier wrote them ("Blanket Bldg & BPP", "Bldg/Contents").
    Blanket: a.model({
      accountId: a.id().required(),
      account: a.belongsTo("Account", "accountId"),
      // Who made this write. Set by the actor proxy in `src/lib/client.ts`,
      // read by the activity-log stream handler and then excluded from the
      // diff so it never renders as a change. A write that arrives without
      // one is attributed to "system" — see STREAMED_MODELS in backend.ts.
      lastWriteBy: a.string(),
      blanketNumber: a.string(),
      amount: a.float(),
      type: a.string(),
      extractionSourceKey: a.string(),
    }),

    // ── General liability application ──────────────────────────────────
    //
    // Its own 1:1 model rather than 25 more columns on an Account that is
    // already ~50 wide. Application data — what is carried or applied for,
    // the ACORD 126's input — which is a different thing from the `gl*`
    // columns on Quote and Policy, where a carrier's answer lives.
    // The account IS the key. Both application sections are 1:1 with an
    // account, and `.identifier(["accountId"])` is what makes that true in
    // the database rather than true by convention: a second create for an
    // account that already has one is rejected by the primary key.
    //
    // Without it, two people first-saving the same blank section at the same
    // moment each see no row, each create one, and one of them is invisible
    // from then on — including to the ACORD 125 mapping, which reads
    // `glRows[0]`. That is a carrier submission missing answers somebody
    // typed. Enforcing it here costs nothing today and cannot be done later
    // without recreating the table.
    GlApplication: a.model({
      accountId: a.id().required(),
      account: a.belongsTo("Account", "accountId"),
      // Who made this write. Set by the actor proxy in `src/lib/client.ts`,
      // read by the activity-log stream handler and then excluded from the
      // diff so it never renders as a change. A write that arrives without
      // one is attributed to "system" — see STREAMED_MODELS in backend.ts.
      lastWriteBy: a.string(),

      // ── Limits ──
      eachOccurrence: a.float(),
      generalAggregate: a.float(),
      // Reuses AggregateAppliesTo rather than declaring a two-member twin.
      // The requirement names only Location and Policy; the existing enum
      // also offers Project and Other and is already wired to the ACORD 25
      // checkboxes. Two enums for one concept is the drift PATTERNS forbids.
      limitAppliesPer: a.ref("AggregateAppliesTo"),
      productsCompletedOpsAggregate: a.float(),
      personalAdvInjury: a.float(),
      damageToRentedPremises: a.float(),
      medicalExpense: a.float(),

      // ── Deductibles ──
      deductibleType: a.ref("GlDeductibleType"),
      propertyDamageDeductible: a.float(),
      bodilyInjuryDeductible: a.float(),

      // ── Sub-contractors ──
      // Nullable booleans on purpose: on an application "no" and "not asked"
      // are different answers, and the UI renders these as Yes/No radios
      // rather than checkboxes so the difference can be expressed.
      usesSubcontractors: a.boolean(),
      subsCarryLowerLimits: a.boolean(),
      subsAllowedWithoutCoi: a.boolean(),
      subcontractedWorkDescription: a.string(),
      paidToSubcontractors: a.float(),
      workSubcontractedPct: a.float(),
      fullTimeEmployees: a.integer(),
      partTimeEmployees: a.integer(),
    }).identifier(["accountId"]),

    // Class codes are a list, so they are rows rather than columns.
    GlClassCode: a.model({
      accountId: a.id().required(),
      account: a.belongsTo("Account", "accountId"),
      // Who made this write. Set by the actor proxy in `src/lib/client.ts`,
      // read by the activity-log stream handler and then excluded from the
      // diff so it never renders as a change. A write that arrives without
      // one is attributed to "system" — see STREAMED_MODELS in backend.ts.
      lastWriteBy: a.string(),
      hazardNumber: a.string(),
      classCode: a.string(),
      premiumBasis: a.ref("GlPremiumBasis"),
      exposure: a.float(),
      description: a.string(),
    }),

    // ── Directors & Officers ───────────────────────────────────────────
    //
    // Parts A, B and C carry identical field sets, so they are three rows of
    // one model rather than twelve columns. Not an add/remove table: the
    // parts are fixed by the form, and the UI renders exactly three.
    DoCoveragePart: a.model({
      accountId: a.id().required(),
      account: a.belongsTo("Account", "accountId"),
      // Who made this write. Set by the actor proxy in `src/lib/client.ts`,
      // read by the activity-log stream handler and then excluded from the
      // diff so it never renders as a change. A write that arrives without
      // one is attributed to "system" — see STREAMED_MODELS in backend.ts.
      lastWriteBy: a.string(),
      part: a.ref("DoPart").required(),
      coverageType: a.ref("DoCoverageType"),
      perClaimLimit: a.float(),
      aggregateLimit: a.float(),
      perClaimRetention: a.float(),
      aggregateRetention: a.float(),
    }),

    // Keyed on the account for the same reason as GlApplication above.
    DoApplication: a.model({
      accountId: a.id().required(),
      account: a.belongsTo("Account", "accountId"),
      // Who made this write. Set by the actor proxy in `src/lib/client.ts`,
      // read by the activity-log stream handler and then excluded from the
      // diff so it never renders as a change. A write that arrives without
      // one is attributed to "system" — see STREAMED_MODELS in backend.ts.
      lastWriteBy: a.string(),
      separateDefenseLimit: a.boolean(),
      defenseLimit: a.float(),
      defenseLimitPosition: a.ref("DefenseLimitPosition"),
      pendingPriorLitigationDate: a.date(),
    }).identifier(["accountId"]),

    // ── Buildings: the ACORD 140's unit of description ─────────────────
    //
    // The 140 is a property section PER BUILDING — two per PDF — so almost
    // everything an underwriter asks about construction and protection is a
    // property of one building, not of the account. The construction columns
    // that used to sit on Account are here now; see W5 in the spec.
    Building: a.model({
      accountId: a.id().required(),
      account: a.belongsTo("Account", "accountId"),
      // Who made this write. Set by the actor proxy in `src/lib/client.ts`,
      // read by the activity-log stream handler and then excluded from the
      // diff so it never renders as a change. A write that arrives without
      // one is attributed to "system" — see STREAMED_MODELS in backend.ts.
      lastWriteBy: a.string(),
      label: a.string(), // "Building A", "Clubhouse", …
      sqft: a.integer(),
      // Each building is its own premises row on ACORD 125, so it needs a
      // street address and an occupancy description of its own.
      streetAddress: a.string(),
      description: a.string(), // "2, 4, 10, 12 John Hancock. Two-story wood frame…"

      // ── Construction ──
      yearBuilt: a.integer(),
      stories: a.integer(),
      basements: a.integer(),
      constructionType: a.ref("ConstructionType"),
      roofType: a.string(),
      roofYear: a.integer(),
      heatingYear: a.integer(),
      wiringYear: a.integer(),
      plumbingYear: a.integer(),

      // ── Protection ──
      distanceToHydrantFt: a.integer(),
      distanceToFireStationMi: a.float(),
      fireProtectionType: a.string(),
      sprinklerPct: a.float(),

      // ── Coverage: the 140's first subject-of-insurance row ──
      individualBuildingValue: a.float(),
      coinsurancePct: a.float(),
      valuation: a.ref("ReplacementCostType"),
      deductibleType: a.ref("BuildingDeductibleType"),
      deductibleAmount: a.float(),
      // Free text, NOT a foreign key to Blanket. The forms print the number
      // an underwriter wrote, deleting a blanket must not orphan a building,
      // and the numbers come off prior declarations rather than being
      // generated here. The edit form offers the account's existing numbers
      // through a datalist, so the common case is still a click.
      blanketNumber: a.string(),
      causeOfLoss: a.ref("CauseOfLoss"),
      formsConditions: a.string(),

      // ── Other ──
      otherOccupancies: a.string(),
      historicalLandmark: a.boolean(),
      sinkholeCoverageAccepted: a.boolean(),
      mineSubsidenceCoverage: a.boolean(),
      remarks: a.string(), // ACORD 101 overflow
      extractionSourceKey: a.string(),
    }),

    // ── Quotes: tied to an account; binding creates a Policy ───────────
    //
    // Authenticated read/write, ADMIN-only delete. There is no standalone
    // "delete quote" anywhere in the app — the only caller is the lead
    // cascade, which is admin-only — so this costs nothing and closes the
    // same hole as the Account rule above.
    //
    // The nightly renewal sweep lists Quote (renewal-tasks/handler.ts) and
    // `extractLead` reads them, both without an explicit authMode. Neither is
    // affected — see the note on `allow.resource` at the bottom of this file.
    Quote: a.model({
      accountId: a.id().required(),
      account: a.belongsTo("Account", "accountId"),
      // Who made this write — see the Contact model's note.
      lastWriteBy: a.string(),
      carrierId: a.id(),
      carrier: a.belongsTo("Carrier", "carrierId"),
      status: a.ref("QuoteStatus").required(),
      lines: a.string().array(), // e.g. ["Property", "GL", "D&O", "Umbrella"]
      premium: a.float(),
      // Agency commission, % of premium. NOTE: already baked into the
      // quoted premium — commission $ is informational, never additive.
      commissionPct: a.float(),
      // ── General liability limits (printed on the ACORD 25 COI) ──
      glEachOccurrence: a.float(),
      glDamageToRentedPremises: a.float(),
      glMedicalExpense: a.float(),
      glPersonalAdvInjury: a.float(),
      glGeneralAggregate: a.float(),
      glProductsCompletedOps: a.float(),
      // "Occurrence" vs "Claims made" form, and what the aggregate applies to.
      glClaimsMade: a.boolean(),
      glAggregateAppliesTo: a.ref("AggregateAppliesTo"),
      // ── Property terms ──
      perOccurrenceDeductible: a.float(),
      perUnitDeductible: a.float(),
      blanketLimit: a.float(),
      coinsurancePct: a.float(),
      replacementCostType: a.ref("ReplacementCostType"),
      effectiveDate: a.date(),
      expirationDate: a.date(),
      notes: a.string(),
      policy: a.hasOne("Policy", "quoteId"),
    })
      .authorization((allow) => [
        allow.authenticated().to(["read", "create", "update"]),
        allow.groups(["ADMIN"]),
      ]),

    // ── Policies: created on bind; source data for COI generation ──────
    //
    // Authenticated read/write, ADMIN-only delete. There is no usable
    // ownership anchor to scope on: no model carries an owning-producer id.
    //
    // The nightly renewal sweep lists Policy (renewal-tasks/handler.ts:59)
    // without an explicit authMode. It is NOT affected by this rule — see the
    // note on `allow.resource` at the bottom of this file.
    Policy: a.model({
      accountId: a.id().required(),
      account: a.belongsTo("Account", "accountId"),
      // Who made this write — see the Contact model's note.
      lastWriteBy: a.string(),
      quoteId: a.id(),
      quote: a.belongsTo("Quote", "quoteId"),
      carrierId: a.id(),
      carrier: a.belongsTo("Carrier", "carrierId"),
      policyNumber: a.string(),
      status: a.ref("PolicyStatus").required(),
      lines: a.string().array(),
      premium: a.float(),
      commissionPct: a.float(), // carried from the bound quote; baked into premium
      // ── General liability limits (printed on the ACORD 25 COI) ──
      glEachOccurrence: a.float(),
      glDamageToRentedPremises: a.float(),
      glMedicalExpense: a.float(),
      glPersonalAdvInjury: a.float(),
      glGeneralAggregate: a.float(),
      glProductsCompletedOps: a.float(),
      // "Occurrence" vs "Claims made" form, and what the aggregate applies to.
      glClaimsMade: a.boolean(),
      glAggregateAppliesTo: a.ref("AggregateAppliesTo"),
      perOccurrenceDeductible: a.float(),
      perUnitDeductible: a.float(),
      blanketLimit: a.float(),
      coinsurancePct: a.float(),
      replacementCostType: a.ref("ReplacementCostType"),
      effectiveDate: a.date(),
      expirationDate: a.date(),
      notes: a.string(),
    })
      .authorization((allow) => [
        allow.authenticated().to(["read", "create", "update"]),
        allow.groups(["ADMIN"]),
      ]),

    // ── Carriers & appointments ────────────────────────────────────────
    Carrier: a.model({
      name: a.string().required(),
      appointed: a.boolean().required(), // false = prospective appointment
      dateAppointed: a.date(),
      primaryContactName: a.string(),
      primaryContactEmail: a.email(),
      primaryContactPhone: a.string(),
      primaryUnderwriterName: a.string(),
      primaryUnderwriterEmail: a.email(),
      primaryUnderwriterPhone: a.string(),
      states: a.string().array(), // states they cover
      naicCode: a.string(), // used on ACORD forms
      standardCommissionPct: a.float(), // autofills onto new quotes
      annualMinimumPremium: a.float(), // min premium written to maintain appointment
      profitSharingPremiumThreshold: a.float(), // premium written to qualify for profit sharing
      profitSharingLossRatioThreshold: a.float(), // max loss ratio % to qualify for profit sharing
      commercialLines: a.boolean(), // writes commercial lines
      personalLines: a.boolean(), // writes personal lines
      notes: a.string(),
      appetiteGuides: a.hasMany("AppetiteGuide", "carrierId"),
      quotes: a.hasMany("Quote", "carrierId"),
      policies: a.hasMany("Policy", "carrierId"),
    }),

    AppetiteGuide: a.model({
      carrierId: a.id().required(),
      carrier: a.belongsTo("Carrier", "carrierId"),
      linesWritten: a.string().array(),
      quoteSubmissionLeadTimeDays: a.integer(),
      minValue: a.float(), // TIV range
      maxValue: a.float(),
      minConstructionYear: a.integer(),
      maxConstructionYear: a.integer(),
      states: a.string().array(), // override carrier states if narrower
      notes: a.string(),
    }),

    // ── Documents: polymorphic, attach to anything, OCR'd by Textract ──
    Document: a
      .model({
        entityType: a.ref("DocumentEntityType").required(),
        entityId: a.string().required(),
        category: a.ref("DocumentCategory"),
        name: a.string().required(),
        s3Key: a.string().required(),
        contentType: a.string(),
        sizeBytes: a.integer(),
        uploadedBy: a.string(),
        ocrStatus: a.ref("OcrStatus"),
        ocrText: a.string(), // full extracted text, searched in-app
        ocrTables: a.json(), // Textract TABLES output (budgets, dues schedules)
        ocrError: a.string(),
        // Who made this write — see the Contact model's note.
        lastWriteBy: a.string(),
      })
      .secondaryIndexes((index) => [index("entityId")]),

    /**
     * Renewal marketing task: "submit this expiring risk to this carrier".
     *
     * Created by the scheduled renewal-tasks function once a risk enters its
     * submission window (carrier lead time + 14 days before expiration), one
     * per appetite-matched appointed carrier.
     *
     * Closes one of two ways: a quote gets created for that carrier, which
     * the sweep and the UI both detect rather than anyone clicking (QUOTED),
     * or a person closes it by hand and says why — the carrier wouldn't want
     * it, the agency didn't want to place it there, or the submission window
     * was missed. The last of those is the one worth counting later, which is
     * why it is a resolution and not a note.
     *
     * All foreign keys are plain fields, not belongsTo — relationships make
     * them GSI keys, and policyId is legitimately empty for lead-sourced
     * tasks. The UI joins client-side.
     */
    MarketingTask: a.model({
      accountId: a.id().required(),
      carrierId: a.id().required(),
      // Set for POLICY-sourced tasks; empty when the source is a lead's
      // current-policy expiration.
      policyId: a.id(),
      sourceType: a.ref("MarketingTaskSource").required(),
      // "<sourceType>:<sourceId>:<carrierId>:<expirationDate>" — the job
      // skips any key it has already created, so daily runs never duplicate.
      dedupeKey: a.string().required(),
      // Denormalized for display without extra reads.
      accountName: a.string(),
      carrierName: a.string(),
      lines: a.string().array(),
      expirationDate: a.date(), // the term that is ending
      leadTimeDays: a.integer(), // carrier lead time the job resolved
      submitBy: a.date(), // expiration − leadTime: the real submission deadline
      triggerDate: a.date(), // submitBy − 14: when the task was raised
      status: a.ref("MarketingTaskStatus").required(),
      resolution: a.ref("MarketingTaskResolution"),
      completedAt: a.datetime(),
      completedBy: a.string(),
      notes: a.string(),
    }),

    // ── Certificates (ACORD 25 issuance history) ───────────────────────
    //
    // Authenticated read/write, ADMIN-only delete. `issuedBy` is a display
    // name string, not a user id, so it can't anchor owner-scoping — and an
    // issuance record shouldn't be erasable by whoever issued it anyway.
    // No Lambda touches this model.
    Certificate: a.model({
      accountId: a.id().required(),
      account: a.belongsTo("Account", "accountId"),
      // Who made this write — see the Contact model's note.
      lastWriteBy: a.string(),
      certificateNumber: a.string(), // unique record-keeping ID, e.g. HOA-2026-00011
      policyIds: a.string().array(),
      holderName: a.string().required(),
      holderAddress: a.string(),
      descriptionOfOperations: a.string(),
      formType: a.string().default("ACORD_25"), // future: ACORD 27/28, carrier forms
      s3Key: a.string(), // generated PDF
      issuedBy: a.string(),
      issuedAt: a.datetime(),
    })
      .authorization((allow) => [
        allow.authenticated().to(["read", "create", "update"]),
        allow.groups(["ADMIN"]),
      ]),

    // ── Users & onboarding ─────────────────────────────────────────────
    /**
     * Reads stay open to every authenticated user; writes are owner-or-ADMIN.
     *
     * Reads must stay open because Licensing and Team both list the whole
     * roster and join against it for holder names — scoping reads would
     * silently render teammates as "—" rather than fail visibly. ACORD
     * generation also reads another user's profile to fetch their signature.
     *
     * The read rule is `allow.authenticated()`, which is STATIC: it authorizes
     * list/get outright, so no owner filter is ever attached to the query.
     * That matters because App.tsx resolves the signed-in user with a filtered
     * `list` on userId, not a `get` — if that list came back empty the app
     * would decide the user has no profile and re-render Onboarding, which
     * creates a second profile row. The owner rule below deliberately grants
     * only create/update, so it never participates in query authorization.
     *
     * `userId` holds the raw Cognito sub (written from AuthUser.userId, which
     * is idToken.payload.sub), so the owner rule must compare against the
     * "sub" claim — the default identity claim is "sub::username" and would
     * match no existing row.
     *
     * ADMIN gets everything because managing a teammate's signature from the
     * Team tab is deliberate (see SignatureManager). Delete is ADMIN-only:
     * nothing in the app deletes a profile, and letting someone delete their
     * own would just silently re-onboard them.
     */
    UserProfile: a
      .model({
        userId: a.string().required(), // Cognito sub
        email: a.email().required(),
        firstName: a.string().required(),
        lastName: a.string().required(),
        role: a.ref("UserRole").required(), // privileges are placeholder for now
        npn: a.string(), // required for producers at onboarding (app-enforced)
        /**
         * Mobile number for lead texts. Free-form as typed — normalised to
         * E.164 at send time by `lead-intake/sms.ts`, not on the way in, so a
         * number saved in any of the shapes people actually type still works
         * and nothing is silently rewritten under the person who typed it.
         */
        mobilePhone: a.string(),
        /**
         * Text me when a web lead arrives. Off unless someone turns it on:
         * an alert nobody asked for is how a phone number ends up blocked.
         *
         * Only inbound leads — the `submitWebLead` mutation. A lead a
         * producer types into the CRM themselves does not text that producer.
         */
        leadTextAlerts: a.boolean(),
        // S3 key of a transparent-PNG signature, drawn into the signature
        // fields of generated ACORD forms. See storage: signatures/*.
        signatureKey: a.string(),
        onboardingComplete: a.boolean().required(),
        licenses: a.hasMany("ProducerLicense", "userProfileId"), // deprecated
      })
      .secondaryIndexes((index) => [index("userId")])
      .authorization((allow) => [
        allow.authenticated().to(["read"]),
        allow
          .ownerDefinedIn("userId")
          .identityClaim("sub")
          .to(["create", "update"]),
        allow.groups(["ADMIN"]),
      ]),

    /**
     * DEPRECATED — superseded by the unified `License` model below, which
     * covers both firm and personal licenses with dates, files and status.
     * Kept so existing onboarding rows aren't dropped; no new writes.
     */
    ProducerLicense: a.model({
      userProfileId: a.id().required(),
      userProfile: a.belongsTo("UserProfile", "userProfileId"),
      state: a.string().required(),
      licenseNumber: a.string().required(),
      expirationDate: a.date(),
      linesOfAuthority: a.string().array(),
    }),

    /**
     * Unified licensing record — one row per (holder, state, license).
     *
     * Firm licenses (holderType=FIRM) have no userProfileId; personal
     * licenses point at the producer's UserProfile. Both share the same
     * fields so renewal tracking, file attachment and the state-coverage
     * matrix are written once and work for either kind.
     *
     * Supporting files (the license PDF, renewal receipts, CE certificates)
     * attach as Documents with entityType=LICENSE, entityId=<license id>.
     *
     * Create stays open to authenticated users: producers self-create their
     * own License rows during onboarding (Onboarding.tsx), before any admin
     * has seen them. Editing and deleting a license — the operations that can
     * make the agency look licensed where it isn't — are ADMIN-only, which is
     * what the Licensing screen already gates its edit/delete controls on.
     * userProfileId is caller-supplied and unverified, so it can't anchor
     * owner-scoping. One Lambda reads this model — the `license-alerts`
     * expiry sweep — and writes nothing back to it; what it sent is recorded
     * on `LicenseReminder` below rather than as a field here, so the daily
     * job cannot touch a compliance record it has no business editing.
     */
    License: a.model({
      holderType: a.ref("LicenseHolderType").required(),
      /**
       * Empty for FIRM licenses; set for PRODUCER licenses.
       *
       * Deliberately a plain field rather than a belongsTo: a relationship
       * makes this a GSI key, and DynamoDB rejects a null index key — which
       * every firm license would need. The UI joins against UserProfile
       * client-side instead (it already lists profiles for the picker).
       */
      userProfileId: a.id(),
      // Denormalized so firm rows and orphaned rows still render a name.
      holderName: a.string(),
      state: a.string().required(),
      licenseNumber: a.string().required(),
      npn: a.string(), // National Producer Number (firms have one too)
      licenseClass: a.ref("LicenseClass"),
      residency: a.ref("LicenseResidency"),
      linesOfAuthority: a.string().array(),
      status: a.ref("LicenseStatus"),
      effectiveDate: a.date(),
      expirationDate: a.date(),
      continuingEducationDueDate: a.date(),
      notes: a.string(),
    })
      .authorization((allow) => [
        allow.authenticated().to(["read", "create"]),
        allow.groups(["ADMIN"]),
      ]),

    /**
     * One row per licence-expiry email the agency has already been sent.
     *
     * The ledger behind `license-alerts`, and the same trick as
     * `MarketingTask.dedupeKey`: the sweep skips any key it has already
     * written, so a retry, a double delivery from EventBridge or a manual
     * re-invoke sends nothing twice.
     *
     * It also decides what a *missed* run costs. Because the rule is "is this
     * licence inside the 60/30/3-day window and unrecorded" rather than "does
     * it expire exactly N days from today", a day the job doesn't run is
     * caught up the next day instead of skipping a deadline silently.
     *
     * `expirationDate` is part of `dedupeKey`, so renewing a licence mints
     * fresh keys and re-arms all three rungs for the new term.
     *
     * Nobody writes this from the app — the Lambda is the only author, and
     * `allow.resource()` is what lets it (see the block at the bottom of this
     * file). Read stays open so the Licensing screen can show when the agency
     * was last told, without another round of plumbing.
     */
    LicenseReminder: a
      .model({
        licenseId: a.id().required(),
        // "<licenseId>:<expirationDate>:<threshold>"
        dedupeKey: a.string().required(),
        threshold: a.integer().required(), // 60 | 30 | 3
        expirationDate: a.date().required(),
        sentAt: a.datetime().required(),
      })
      .authorization((allow) => [allow.authenticated().to(["read"])]),

    // ── Public website → CRM lead intake ───────────────────────────────
    // API-key-only surface for protectmyhoa.com forms. The handler forces
    // stage=LEAD; this cannot create clients or touch existing records.
    submitWebLead: a
      .mutation()
      .arguments({
        type: a.string(), // ASSOCIATION | PERSONAL | COMMERCIAL_OTHER
        name: a.string().required(),
        contactFirstName: a.string(),
        contactLastName: a.string(),
        contactEmail: a.string(),
        contactPhone: a.string(),
        address: a.string(),
        city: a.string(),
        state: a.string(),
        zip: a.string(),
        unitNumber: a.string(),
        currentCarrier: a.string(),
        buildiumId: a.string(),
        source: a.string(),
        notes: a.string(),
      })
      .returns(a.json())
      .authorization((allow) => [allow.publicApiKey()])
      .handler(a.handler.function(leadIntake)),

    // ── Team administration (ADMIN group only) ─────────────────────────
    inviteUser: a
      .mutation()
      .arguments({
        email: a.string().required(),
        role: a.string(), // ADMIN | STAFF | PRODUCER (default STAFF)
      })
      .returns(a.json())
      .authorization((allow) => [allow.groups(["ADMIN"])])
      .handler(a.handler.function(teamAdmin)),

    listTeamUsers: a
      .query()
      .returns(a.json())
      .authorization((allow) => [allow.groups(["ADMIN"])])
      .handler(a.handler.function(teamAdmin)),

    // ── AI extraction: kick off async document → datapoints extraction ──
    startLeadExtraction: a
      .mutation()
      .arguments({ accountId: a.string().required() })
      .returns(a.json())
      .authorization((allow) => [allow.authenticated()])
      .handler(a.handler.function(extractLead)),

    // ── AI form filling: complete the blanks a mapping cannot ──────────
    // Called after a deterministic fill, with the names of the text fields
    // still empty. Returns { ok, values: [{ field, value, why }], skipped }.
    // Nothing here writes: the browser holds the PDF and shows every value
    // to the producer before the document is stored.
    suggestFormFields: a
      .mutation()
      .arguments({
        accountId: a.string().required(),
        formKey: a.string().required(),
        fieldNames: a.string().array().required(),
      })
      .returns(a.json())
      .authorization((allow) => [allow.authenticated()])
      .handler(a.handler.function(formFiller)),

    // ── Certificate numbering: atomically reserve the next COI number ──
    // Returns { certificateNumber, year, seq }. Uniqueness is guaranteed by
    // an atomic DynamoDB counter — see the cert-number function.
    reserveCertificateNumber: a
      .mutation()
      .returns(a.json())
      .authorization((allow) => [allow.authenticated()])
      .handler(a.handler.function(certNumber)),
  })
  .authorization((allow) => [
    // Default for every model that doesn't declare its own rules. A model
    // with its own `.authorization()` replaces `allow.authenticated()` below
    // for that model — but NOT the `allow.resource()` grants, which are not
    // per-model at all:
    //
    //   - `allow.resource()` rules are stripped out of the schema auth list
    //     before any @auth directive is generated (data-schema's
    //     extractFunctionSchemaAccess) and turned into an IAM policy granting
    //     appsync:GraphQL on <api>/types/Query|Mutation|Subscription/* — the
    //     whole API, every field.
    //   - Amplify always sets iamConfig.enableIamAuthorizationMode: true,
    //     documented as "Enables access for IAM principals. If enabled @auth
    //     directive rules are not applied."
    //
    // So these four functions keep full data access regardless of what any
    // model declares, and the model-level `allow` builder doesn't even expose
    // `.resource()` to re-declare with. Do not try.
    allow.authenticated(),
    // The Textract pipeline function writes OCR results back to Document.
    allow.resource(processDocument),
    // The web-lead intake function creates Account records.
    allow.resource(leadIntake),
    // The AI extraction function reads Documents and updates Accounts.
    allow.resource(extractLead),
    // The form filler reads an account and everything under it. It writes
    // nothing — the grant above is API-wide (see the block at the top of
    // this list), so that is a property of the handler, not of the schema.
    allow.resource(formFiller),
    // The daily sweep reads policies/carriers/quotes and writes MarketingTasks.
    allow.resource(renewalTasks),
    // The licence-expiry sweep reads Licenses and writes LicenseReminders.
    // Note what the block above says: this is API-wide, so "reads Licenses"
    // is a property of the handler, not something the schema enforces —
    // License's own rules gate a signed-in user, not an IAM principal.
    allow.resource(licenseAlerts),
    // The weekday digest reads open MarketingTasks and writes nothing at all.
    // As with the two above, the grant is API-wide, so read-only is a property
    // of the handler rather than something the schema holds it to.
    allow.resource(taskDigest),
    // The stream handler writes Activity and reads UserProfile to name an
    // actor. Note what the block above says: this is not a per-model grant,
    // so this function has full API access whatever any model declares. What
    // keeps Activity write-only-from-here is the model's own rule denying
    // create/update/delete to a signed-in user — an IAM principal is not
    // subject to it, and a Cognito one is.
    allow.resource(activityLog),
  ]);

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: "userPool",
    // Only the submitWebLead mutation opts into API key auth.
    apiKeyAuthorizationMode: {
      expiresInDays: 365,
    },
  },
});
