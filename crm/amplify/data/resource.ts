import { type ClientSchema, a, defineData } from "@aws-amplify/backend";
import { processDocument } from "../functions/process-document/resource";
import { leadIntake } from "../functions/lead-intake/resource";
import { teamAdmin } from "../functions/team-admin/resource";
import { extractLead } from "../functions/extract-lead/resource";
import { formFiller } from "../functions/form-filler/resource";
import { certNumber } from "../functions/cert-number/resource";
import { invoiceNumber } from "../functions/invoice-number/resource";
import { sendInvoice } from "../functions/send-invoice/resource";
import { voidInvoice } from "../functions/void-invoice/resource";
import { pfAdmin } from "../functions/pf-admin/resource";
import { pfOriginate } from "../functions/pf-originate/resource";
import { pfAgreement } from "../functions/pf-agreement/resource";
import { pfServicing } from "../functions/pf-servicing/resource";
import { pfDefaultSweep } from "../functions/pf-default-sweep/resource";
import { pfElection } from "../functions/pf-election/resource";
import { pfAutopay } from "../functions/pf-autopay/resource";
import { renewalTasks } from "../functions/renewal-tasks/resource";
import { licenseAlerts } from "../functions/license-alerts/resource";
import { taskDigest } from "../functions/task-digest/resource";
import { opsRollup } from "../functions/ops-rollup/resource";
import { leadUpload } from "../functions/lead-upload/resource";
import { uploadPortal } from "../functions/upload-portal/resource";
import { portalSweep } from "../functions/portal-sweep/resource";
import { leadReply } from "../functions/lead-reply/resource";
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
    /**
     * Who collects the premium from the association.
     *
     * AGENCY — the agency bills the insured, collects the gross premium and
     * remits it to the carrier net of commission. These are the policies the
     * Invoice model is about; see the note on it, which assumes exactly this
     * arrangement.
     *
     * DIRECT — the carrier bills the insured itself and pays commission to the
     * agency afterwards. Nothing passes through the agency's account, so a
     * direct-bill policy is not something to raise a premium invoice for.
     *
     * Captured at bind because it is a term of the placement, not a property
     * of the account: the same association can be agency bill with one carrier
     * and direct bill with another, and which one it is decides whether anyone
     * here is supposed to chase the money.
     */
    BillType: a.enum(["AGENCY", "DIRECT"]),
    /**
     * QUOTED until someone commits to it; see the premium-finance spec.
     * ACCEPTED (W7) sits between QUOTED and ACTIVE: the association elected
     * financing from the invoice email — down payment received, autopay
     * mandate on file — but the executed board resolution is not yet. Money
     * has moved on an ACCEPTED loan, so nothing may auto-cancel it; the
     * webhook's superseded-by-payment rule reaches QUOTED only.
     */
    PfLoanStatus: a.enum(["QUOTED", "ACCEPTED", "ACTIVE", "PAID", "DEFAULTED", "CANCELLED"]),
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
      // The two the upload portal asks for that had no home. Both are things a
      // carrier prices on, so filing them as OTHER lost the distinction that
      // makes them worth having — see shared/leadDocuments.ts.
      "STATEMENT_OF_VALUES", // building schedule: sqft and insured value per building
      // Generated premium-finance paperwork — never uploaded, never extracted.
      "PF_AGREEMENT",
      "PF_BOARD_RESOLUTION",
      // The SIGNED scan of the board resolution, uploaded by hand. Its own
      // category because activation requires it positively: "some document
      // on the account" proves nothing, and the generated draft above is
      // the likeliest wrong paste.
      "PF_RESOLUTION_EXECUTED",
      "PROPERTY_UPDATES", // roof/electrical/plumbing/heating work
      "OTHER",
    ]),
    OcrStatus: a.enum(["PENDING", "PROCESSING", "COMPLETE", "FAILED", "SKIPPED"]),
    ExtractionStatus: a.enum(["PENDING", "PROCESSING", "COMPLETE", "FAILED"]),
    /**
     * The auto-reply window for one website lead.
     *
     * WAITING — the upload window is open, nothing sent.
     * SENDING — a sweep has claimed it; stops a second sweep double-sending.
     * SENT / FAILED — terminal.
     */
    LeadReplyStatus: a.enum(["WAITING", "SENDING", "SENT", "FAILED"]),
    /**
     * DRAFT      — being built, nothing sent, freely editable.
     * SENT       — emailed to the insured; the amount is now a claim on them.
     * PROCESSING — they have authorised payment but the money has not arrived.
     * PAID       — settled, money received.
     * VOID       — cancelled. Kept rather than deleted so the number is never reused.
     *
     * PROCESSING exists because of ACH. A bank debit is authorised in the
     * checkout and clears days later, and it can still fail after the payer has
     * done everything right. Marking such an invoice PAID the moment they press
     * the button would be recording money that has not moved, which is the one
     * kind of wrong a billing system must not be.
     */
    InvoiceStatus: a.enum(["DRAFT", "SENT", "PROCESSING", "PAID", "VOID"]),
    /**
     * What a line is, which is what decides whether it carries margin.
     *
     * PREMIUM is the only kind that normally does: the agency bills the gross
     * and remits it net of commission. Taxes, surplus lines and stamping fees
     * are pass-through — billed at exactly what is owed, cost equal to retail —
     * and are separate kinds so a zero margin on them reads as correct rather
     * than as someone forgetting to enter a cost.
     */
    InvoiceLineKind: a.enum([
      "PREMIUM",
      "ENDORSEMENT",
      "TAX",
      "SURPLUS_LINES",
      "STAMPING_FEE",
      /**
       * Interest charged on an in-house payment plan.
       *
       * Not yet offered, and here now because the remittance split sent to
       * corporate accounting has to name it: interest is agency income of a
       * different kind from commission — earned for lending rather than for
       * placing — and the two are taxed and reported differently. Present as a
       * category that reads zero rather than one bolted on later, so the first
       * financed invoice needs a line, not a release.
       */
      "INTEREST",
      "OTHER",
    ]),
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
        /**
         * Whether the association is an incorporated entity — a recorded
         * fact from its articles, not an inference from its type. Rhode
         * Island's premium-finance eligibility (§ 19-14.1-10(b)(1)) reads
         * this and blocks until someone answers. Additive nullable, per the
         * module's schema rule.
         */
        incorporated: a.boolean(),
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
        invoices: a.hasMany("Invoice", "accountId"),
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
      lines: a.string().array(), // e.g. ["Commercial Property", "General Liability", "D&O", "Umbrella"]
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
      /**
       * MEP is recorded for underwriting parity only (screen retired
       * 2026-08-24). producerOfRecord and isAuditable are DEAD FIELDS —
       * their screens retired the same day ("we are always the producer of
       * record"; "everything we do is final once entered") — kept for rows
       * that carry answers, read and written by nothing.
       */
      producerOfRecord: a.boolean(),
      isAuditable: a.boolean(),
      minimumEarnedPremiumPct: a.float(),
      policy: a.hasOne("Policy", "quoteId"),
      /** W8: pre-bind billing anchors here; see Invoice.quoteId. */
      invoices: a.hasMany("Invoice", "quoteId"),
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
      /**
       * Required by the bind form, optional here.
       *
       * Every policy created from now on has one — `BindForm` will not submit
       * without it. Declaring it `.required()` in the schema would instead make
       * AppSync fail the *read* of every policy bound before this field
       * existed, turning a missing answer into an unopenable record.
       */
      billType: a.ref("BillType"),
      /**
       * ── Premium-finance eligibility facts (W3), mostly retired ──
       *
       * DEAD FIELDS — the producer-of-record screen retired 2026-08-24
       * ("we are always the producer of record": the agency writes no
       * wholesale paper, so the screen only ever blocked its own deals on
       * an unticked box). Kept for rows that carry answers and stamps;
       * read and written by nothing. MEP below stays as underwriting data.
       */
      producerOfRecord: a.boolean(),
      producerOfRecordBy: a.string(),
      producerOfRecordAt: a.datetime(),
      /** Carrier's minimum earned premium %, off the policy PDF. */
      minimumEarnedPremiumPct: a.float(),
      /**
       * DEAD FIELD — the auditable screen retired 2026-08-24 ("everything
       * we do is final once entered"); kept for rows that carry an answer,
       * read and written by nothing.
       */
      isAuditable: a.boolean(),
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
      /**
       * When the bind actually happened — stamped automatically by the bind
       * flow, never typed. Distinct from effectiveDate (when coverage
       * starts) and from the implicit createdAt (which any backfill or
       * migration would overwrite the meaning of). Nullable for policies
       * bound before the field existed — same back-compat rule as billType.
       */
      datePolicyBound: a.datetime(),
      notes: a.string(),
      invoices: a.hasMany("Invoice", "policyId"),
      invoiceLines: a.hasMany("InvoiceLine", "policyId"),
    })
      .authorization((allow) => [
        allow.authenticated().to(["read", "create", "update"]),
        allow.groups(["ADMIN"]),
      ]),

    /**
     * What the association is billed, and what it costs us.
     *
     * ── The billing model this assumes ──────────────────────────────────────
     * Agency bill, commission inside the premium. The agency collects the gross
     * premium from the association and remits it to the carrier net of
     * commission, so on a premium line `retailAmount` is what the association
     * pays and `costAmount` is what is owed to the carrier. The difference is
     * the agency's revenue, and the association never sees it — the invoice
     * shows retail only.
     *
     * That is why there is no agency-fee kind. A separate fee charged on top of
     * premium would engage 940 CMR 38.00 and DOI Bulletin 2013-09, which
     * require the fee to be itemised with its purpose stated and the total
     * shown more prominently than any other figure. Adding such a line later is
     * a compliance decision before it is a schema one.
     *
     * ── Totals are not stored ───────────────────────────────────────────────
     * Retail, cost and margin are all computed from the lines by
     * `lib/invoiceTotals.ts`. A stored total is a second copy of a number that
     * can silently disagree with the rows under it, and this one would be
     * disagreeing about money.
     */
    Invoice: a.model({
      accountId: a.id().required(),
      account: a.belongsTo("Account", "accountId"),
      /** Optional: a policy can have several, and some bill no policy at all. */
      policyId: a.id(),
      policy: a.belongsTo("Policy", "policyId"),
      /**
       * W8: the pre-bind anchor — an invoice may bill a quote before any
       * policy exists. Exactly one of policyId/quoteId is set at creation;
       * bind adds policyId (the rollover) and quoteId stays for history.
       * Every exclusion scan matches either anchor.
       */
      quoteId: a.id(),
      quote: a.belongsTo("Quote", "quoteId"),
      /** INV-2026-00001. Reserved atomically — see reserveInvoiceNumber. */
      number: a.string(),
      status: a.ref("InvoiceStatus").required(),
      issuedAt: a.date(),
      dueAt: a.date(),
      /**
       * Where the association pays.
       *
       * A plain string a producer pastes from the payment processor, rather
       * than an integration, because the processor has not been chosen yet.
       * When one is, this is the single field it fills and nothing else about
       * invoicing has to change.
       */
      paymentUrl: a.string(),
      /** Shown to the insured, above the lines. */
      memo: a.string(),
      sentAt: a.datetime(),
      /** The address it actually went to, which may not be today's contact. */
      sentTo: a.string(),
      paidAt: a.date(),
      /**
       * The Stripe payment link backing `paymentUrl`, so a resend reuses the
       * link rather than minting a second one for the same bill. Two live links
       * for one invoice is how an association pays twice.
       */
      stripePaymentLinkId: a.string(),
      /**
       * The PaymentIntent this invoice's state currently reflects. Written by
       * the webhook.
       */
      stripePaymentIntentId: a.string(),
      /**
       * When the last event we acted on was created, per Stripe's clock.
       *
       * Stripe does not promise ordered delivery, and a redelivery of an old
       * event is ordinary. Without this an out-of-order `processing` can revive
       * a failed payment, and an out-of-order `payment_failed` can bury one
       * that is still clearing — both of which misstate whether money is coming.
       * Anything older than this is ignored.
       */
      stripeEventAt: a.datetime(),
      /**
       * When the PaymentIntent this state reflects was created.
       *
       * Stripe's event clock has one-second resolution, so two events from
       * different attempts can tie. A replacement intent is always created after
       * the one it replaces, which is what breaks that tie.
       */
      stripeIntentCreatedAt: a.datetime(),
      /**
       * The amount, in cents, the Stripe link was minted for.
       *
       * A Payment Link's Price is fixed. Editing an invoice's lines and sending
       * again would otherwise show the new total while the Pay button charged
       * the old one, so a change here is what forces the link to be replaced.
       */
      stripeLinkAmountCents: a.integer(),
      /**
       * How the money collected divides, in cents, as of the last send.
       *
       * ── Why stored and not computed on payment ──
       * The webhook is what tells corporate accounting a payment landed, and it
       * has the invoice row and nothing else. Recomputing from the lines would
       * mean reading them, and — worse — would split whatever the lines say
       * *now*, which is not necessarily what was charged: a Payment Link's
       * price is fixed when it is minted, so an invoice edited after sending
       * would report a division of an amount nobody paid.
       *
       * Written beside `stripeLinkAmountCents`, from the same totals, on every
       * send. The three always sum to it, and all four describe one charge.
       */
      remittanceCarrierCents: a.integer(),
      remittanceCommissionCents: a.integer(),
      remittanceInterestCents: a.integer(),
      lines: a.hasMany("InvoiceLine", "invoiceId"),
      // Streamed. Money changing hands is the clearest case in the schema for
      // "who did this, and when" — see STREAMED_MODELS in backend.ts.
      lastWriteBy: a.string(),
    })
      .secondaryIndexes((index) => [index("accountId").sortKeys(["status"])])
      .authorization((allow) => [
        allow.authenticated().to(["read", "create", "update"]),
        allow.groups(["ADMIN"]),
      ]),

    InvoiceLine: a.model({
      invoiceId: a.id().required(),
      invoice: a.belongsTo("Invoice", "invoiceId"),
      /**
       * The account, denormalised from the invoice.
       *
       * The Invoices tab reads every line the account has, once, to total each
       * row and to work out which policies are already billed. Without this it
       * would be one list call per invoice to render a summary table — six
       * round trips to answer "what does this association owe us".
       *
       * Written by the only two things that create lines, and never edited: a
       * line cannot move between accounts, because it cannot move between
       * invoices.
       */
      accountId: a.id(),
      /**
       * Which policy this line bills, when it bills one.
       *
       * `Invoice.policyId` says what the invoice as a whole is about, which is
       * enough when a bill covers one policy and not enough when it covers
       * three — and covering several is the ordinary case at renewal, when an
       * association's package, umbrella and D&O all fall due together.
       *
       * It is also what makes "which policies have not been billed yet"
       * answerable. Without it the question can only be asked of the invoice,
       * so a policy that appears as a line on a multi-policy invoice still
       * reads as unbilled and gets seeded onto the next one.
       */
      policyId: a.id(),
      policy: a.belongsTo("Policy", "policyId"),
      description: a.string(),
      kind: a.ref("InvoiceLineKind"),
      /** What the association pays for this line. */
      retailAmount: a.float(),
      /** What is owed to the carrier for it. Never shown to the insured. */
      costAmount: a.float(),
      /** Display order, so a reordered invoice does not depend on ids. */
      sortOrder: a.integer(),
      updatedBy: a.string(),
    })
      .authorization((allow) => [
        allow.authenticated().to(["read", "create", "update", "delete"]),
        allow.groups(["ADMIN"]),
      ]),

    /**
     * Premium finance compliance log — the record that shows an examiner the
     * control was operating.
     *
     * Every gate decision, override, and module-flag flip writes a row: which
     * rule fired, on what inputs, with what outcome, by whom, when. Immutable
     * by construction, one step past even Activity: the client — ADMIN
     * included — can only read. Writes come from the pf Lambdas over IAM,
     * which model rules do not bind (see the allow.resource() note at the
     * bottom of this schema). No lastWriteBy: this model is not streamed —
     * an audit log of the audit log is noise — and activityLog.test.ts counts
     * lastWriteBy declarations.
     */
    PfComplianceLog: a
      .model({
        /** Sparse — module-level events (the flag) have no account. */
        accountId: a.string(),
        /** Jurisdiction code, or "ALL" for module-level events. */
        jurisdiction: a.string(),
        /** Which control fired: module-flag, jurisdiction-gate, coverage, apr-cap… */
        rule: a.string().required(),
        inputs: a.json(),
        /** PASS | BLOCK | ENABLED | DISABLED | OVERRIDE */
        outcome: a.string().required(),
        reason: a.string(),
        /** Cognito sub of the person whose action was evaluated. */
        actor: a.string(),
        actorName: a.string(),
        /**
         * SHA-256 of the signed jurisdiction YAML in force when this decision
         * was made. The admin screen's hash says what production runs today;
         * this one answers the regulator's actual question — which signed
         * ruleset governed a specific decision, months and re-signings later.
         * Every writer stamps it.
         */
        configSha256: a.string(),
        occurredAt: a.datetime().required(),
      })
      .secondaryIndexes((index) => [index("accountId").sortKeys(["occurredAt"])])
      .authorization((allow) => [allow.authenticated().to(["read"])]),

    /**
     * A premium finance loan, from quote to close.
     *
     * The client can only READ. Every write — creation included — happens in
     * the pf Lambdas over IAM, because creation IS the control point: the
     * jurisdiction gate, the APR cap, the coverage screen and the eligibility
     * checks all run server-side in issueFinanceQuote, and a client-writable
     * model would be a path around all of them. The terms and schedule are
     * FROZEN COPIES taken at issuance: the quote a borrower signs must not
     * drift when a policy row is edited later.
     *
     * No compensation fields of any kind belong here — no commission, fee
     * split, referral or producer payment from the lending side. Nine states
     * prohibit it and the schema must not be able to express it; a grep test
     * holds this section to that.
     */
    PfLoan: a
      .model({
        accountId: a.id().required(),
        /**
         * W8: optional, because a loan can originate against a QUOTE-billed
         * invoice before any policy exists. Exactly one of policyId/quoteId
         * anchors a live loan; BIND_ROLLOVER sets policyId when the quote
         * binds. Every exclusion scan matches the invoice's anchor.
         */
        policyId: a.id(),
        quoteId: a.id(),
        status: a.ref("PfLoanStatus").required(),
        /** Jurisdiction code at origination — frozen; moves do not re-gate. */
        state: a.string().required(),
        /** SHA-256 of the signed ruleset that approved this origination. */
        configSha256: a.string().required(),
        premium: a.float().required(),
        downPct: a.float().required(),
        months: a.integer().required(),
        apr: a.float().required(),
        effectiveDate: a.date().required(),
        downPayment: a.float().required(),
        amountFinanced: a.float().required(),
        payment: a.float().required(),
        totalInterest: a.float().required(),
        originationFee: a.float().required(),
        /** The frozen amortization schedule, as issued. */
        schedule: a.json().required(),
        /** Servicing state (W5): current balance, next due, last posted n. */
        balance: a.float(),
        nextDueAt: a.date(),
        paidThrough: a.integer(),
        quotedBy: a.string(),
        quotedByName: a.string(),
        quotedAt: a.datetime().required(),
        activatedAt: a.datetime(),
        /** Set when a due installment goes unposted; cured by a posting. */
        defaultedAt: a.datetime(),
        /**
         * The executed board resolution's date, checked at activation against
         * the financed term's effective date — the staleness rule. Boards
         * turn over annually; a resolution from the prior term authorizes
         * nothing.
         */
        boardResolutionExecutedAt: a.date(),
        boardResolutionDocumentId: a.string(),
        cancellationEffectiveAt: a.date(),
        /** When the carrier's unearned-premium refund is expected: +30 days. */
        expectedCarrierRefundAt: a.date(),
        closedAt: a.datetime(),
        /**
         * W7 election + autopay. All additive-nullable, per the module's
         * schema rule. The token is minted by send-invoice when the email
         * offers financing; it names this loan on the public election page,
         * and the page's Lambda re-validates everything server-side — the
         * token is possession, never authority.
         */
        electionToken: a.string(),
        electionTokenExpiresAt: a.datetime(),
        electedAt: a.datetime(),
        /** The invoice recipient the election link was mailed to. */
        electionEmail: a.string(),
        stripeCustomerId: a.string(),
        /** The ACH mandate's saved payment method; presence = autopay on. */
        stripePaymentMethodId: a.string(),
        downPaymentIntentId: a.string(),
        /** Payment 1 of the schedule, received. Set by the webhook only. */
        downPaidAt: a.datetime(),
        /**
         * The in-flight autopay debit, if any: intent id, which installment,
         * and when it was created. Set by pf-autopay, cleared by the webhook
         * on succeeded/failed. The default sweep must not flip a loan whose
         * due installment has a fresh pending debit — ACH clears in days,
         * and a default during clearing would start the notice sequence
         * against money already in flight.
         */
        autopayPendingIntentId: a.string(),
        autopayPendingInstallment: a.integer(),
        autopayAttemptedAt: a.datetime(),
        /**
         * Set when a debit for this installment FAILED: autopay stands down
         * for that installment (one attempt each, not a daily retry loop),
         * which is what lets the default sweep flip the loan and the notice
         * sequence take over. Cleared by any successful posting — a cure
         * resumes the schedule.
         */
        autopayFailedInstallment: a.integer(),
        /**
         * The live election Checkout session, reused until it expires so a
         * public accept cannot mint unbounded Stripe objects.
         */
        electionCheckoutUrl: a.string(),
        electionCheckoutExpiresAt: a.datetime(),
        /**
         * W8: the agreement's click-wrap signature, captured on the election
         * page BEFORE any Checkout session can exist. Name and role are what
         * the signer typed (PM, PM's finance team, board member); the
         * instant and IP are server-stamped in the election transaction.
         * Distinct from the board resolution the activation gate demands.
         */
        agreementSignedAt: a.datetime(),
        agreementSignedName: a.string(),
        agreementSignedRole: a.string(),
        agreementSignedIp: a.string(),
      })
      .secondaryIndexes((index) => [
        index("accountId").sortKeys(["quotedAt"]),
        index("electionToken"),
      ])
      .authorization((allow) => [allow.authenticated().to(["read"])]),

    /**
     * One posted installment. Client read-only; the Lambdas are the only
     * writers, so the interest/principal split always comes from the loan's
     * frozen schedule. Decision 5 as revised 2026-08-23: receipts settle to
     * the premium trust on the one Stripe rail, and the loan-vs-premium
     * distinction lives HERE, on the ledger row and in the remittance email
     * corporate accounting divides the trust by — not in a separate bank
     * account. No compensation fields; see PfLoan's note.
     */
    PfLoanPayment: a
      .model({
        loanId: a.id().required(),
        accountId: a.id().required(),
        n: a.integer().required(),
        amount: a.float().required(),
        interest: a.float().required(),
        principal: a.float().required(),
        /**
         * Where the receipt settled. Historic rows carry the designated
         * lending-account label from before decision 5 was revised; rows
         * written since carry the trust-rail constant.
         */
        bankAccount: a.string().required(),
        postedAt: a.datetime().required(),
        postedBy: a.string(),
        postedByName: a.string(),
        /** Set when the posting came off an autopay debit. */
        stripePaymentIntentId: a.string(),
      })
      .secondaryIndexes((index) => [index("loanId").sortKeys(["postedAt"])])
      .authorization((allow) => [allow.authenticated().to(["read"])]),

    /** INTENT_TO_CANCEL starts the 15-day clock; CERT_OF_MAILING proves it
     * was mailed; CANCELLATION_REQUEST may exist only after both. */
    PfNoticeType: a.enum(["INTENT_TO_CANCEL", "CERT_OF_MAILING", "CANCELLATION_REQUEST"]),

    /**
     * One step of the cancellation notice sequence — where lender liability
     * lives, so: client read-only, rows created complete by the servicing
     * Lambda with server-set timestamps, never updated, never deleted.
     * Nothing in the sequence can be skipped or back-dated through any UI,
     * because no UI can write here at all.
     */
    PfNotice: a
      .model({
        loanId: a.id().required(),
        accountId: a.id().required(),
        type: a.ref("PfNoticeType").required(),
        occurredAt: a.datetime().required(),
        /** Intent rows: when the 15-day clock expires. */
        clockExpiresAt: a.datetime(),
        /** Cert and cancellation rows: the intent they belong to. */
        refNoticeId: a.string(),
        /** Cert rows: the physical USPS form's own date and number. */
        certMailedAt: a.date(),
        certNumber: a.string(),
        certDocumentId: a.string(),
        createdBy: a.string(),
        createdByName: a.string(),
      })
      .secondaryIndexes((index) => [index("loanId").sortKeys(["occurredAt"])])
      .authorization((allow) => [allow.authenticated().to(["read"])]),

    /**
     * A counsel opinion that unlocks a `conditional` jurisdiction — until one
     * exists and is within its review date, conditional means blocked.
     *
     * ADMIN-only create, nobody updates or deletes: superseding an opinion is
     * a new row with a later effective date, and the old one stays in the
     * record. `reviewBy` is the expiry of reliance (default 24 months out):
     * statutes change, and a 2026 opinion must not silently authorize a 2031
     * origination — past review, the jurisdiction reverts to blocked.
     */
    PfCounselOpinion: a
      .model({
        /** Two-letter jurisdiction code, e.g. "VA". */
        jurisdiction: a.string().required(),
        effectiveAt: a.date().required(),
        reviewBy: a.date().required(),
        /** The signed opinion PDF's Document id, when uploaded. */
        documentId: a.string(),
        notes: a.string(),
        uploadedBy: a.string(),
        uploadedByName: a.string(),
        occurredAt: a.datetime().required(),
      })
      .secondaryIndexes((index) => [index("jurisdiction").sortKeys(["effectiveAt"])])
      .authorization((allow) => [
        allow.authenticated().to(["read"]),
        allow.groups(["ADMIN"]).to(["read", "create"]),
      ]),

    /**
     * HISTORICAL — an admin's written reason for waiving one eligibility
     * check on one anchor. Both overridable screens (MEP, then auditable)
     * retired 2026-08-24, so nothing consults or creates these rows any
     * more; the model stays because an override once relied on is an audit
     * record, and audit records do not get deleted.
     */
    PfOverride: a
      .model({
        /**
         * The ANCHOR the override attaches to — a policy id, or since W8 a
         * quote id for pre-bind billing. The name predates quote anchoring
         * and stays for the existing rows' sake.
         */
        policyId: a.id().required(),
        /** MEP | AUDITABLE — both historical. */
        check: a.string().required(),
        reason: a.string().required(),
        actor: a.string(),
        actorName: a.string(),
        occurredAt: a.datetime().required(),
      })
      .secondaryIndexes((index) => [index("policyId")])
      .authorization((allow) => [
        // Read-only for everyone since the screens retired: a new override
        // row would waive nothing, and a write path to nowhere invites
        // someone to believe it did.
        allow.authenticated().to(["read"]),
        allow.groups(["ADMIN"]).to(["read"]),
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
        /**
         * Anchor links (2026-08-24): the policy or quote this paper is
         * about, as plain nullable ids. The document still BELONGS to its
         * account — entityType/entityId stay the storage and query root, so
         * every account-scoped consumer (the tab's live query, the delete
         * cascade, the activation picker, search) keeps seeing everything;
         * these are metadata on top. Bind's rollover adds policyId to
         * quote-linked rows, exactly as invoices and loans roll. (The
         * entityType enum's QUOTE/POLICY values stay deliberately unused:
         * re-rooting documents under them would orphan them from every
         * account-scoped scan.)
         */
        policyId: a.id(),
        quoteId: a.id(),
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
     * Agency-wide identifiers that every user needs to hand and nobody should
     * have to look up — the agency's NPN and its DRLP's NPN. Carriers and
     * state portals ask for both constantly, so they are shown in the sidebar
     * for copying rather than kept on a screen someone has to navigate to.
     *
     * ── One row, id `AGENCY` ──
     * A singleton, not a table of settings. The id is the fixed constant in
     * `src/lib/agencySettings.ts`, so a read is a `get` rather than a `list`
     * whose first element you hope is the right one. Nothing enforces
     * singularity at the API — an admin could create a second row by id — but
     * nothing in the app offers a way to, and a stray row is invisible rather
     * than harmful.
     *
     * ── Why not `shared/agency.ts` ──
     * The address, phone and email live there because they are printed on
     * ACORD forms already sent to carriers and changing one is a deploy you
     * want to review. These two are asked to change without one, which is the
     * whole reason they are a record: an NPN correction should not wait on a
     * release. If that ever stops being true they belong in that module with
     * the rest of the agency's identity.
     *
     * Everyone reads; only ADMIN writes. These appear on submissions, so a
     * wrong value is a filing problem rather than a display bug.
     */
    AgencySettings: a
      .model({
        /** The agency's own National Producer Number. */
        agencyNpn: a.string(),
        /** The Designated Responsible Licensed Producer's NPN. */
        drlpNpn: a.string(),
        /**
         * The agency's federal EIN, stored exactly as typed — the hyphen is
         * part of the value, the way `Account.fein` holds an association's.
         * Here for the same reason as the NPNs: carriers, W-9s and state
         * filings ask for it constantly, and it belongs beside them rather
         * than in someone's notes app.
         */
        agencyEin: a.string(),
        /**
         * The premium-finance kill switch.
         *
         * Written ONLY by the setPremiumFinanceEnabled mutation (pf-admin),
         * so every flip lands in PfComplianceLog with who and when — counsel
         * says stop, an admin stops it in minutes, and the record exists.
         * The ordinary Settings save path must never write this field.
         * Absent means off: the module ships dark.
         */
        premiumFinanceEnabled: a.boolean(),
        /**
         * When the flag last changed — the serialization stamp. Enable writes
         * conditionally on it being unchanged since the invocation began, so
         * an in-flight enable cannot overwrite a disable that landed after it
         * started; disable writes unconditionally, because off always wins.
         */
        premiumFinanceEnabledAt: a.datetime(),
        /**
         * The designated lending bank account's label. Loan receipts and
         * disbursements reference it and it must never name the premium
         * trust: fiduciary premium and lending capital cannot commingle.
         * Payment posting refuses until this is set.
         */
        pfLendingAccountName: a.string(),
        /**
         * Who last changed these, for the obvious "who typed that?" question.
         *
         * Deliberately NOT `lastWriteBy`. That name belongs to the streamed
         * models, where the activity-log handler stamps it to attribute an
         * entry in an account's timeline — this model is not streamed and has
         * no timeline, so borrowing the name would imply a mechanism that does
         * not run here. `activityLog.test.ts` counts the declarations and
         * would have caught it.
         */
        updatedBy: a.string(),
      })
      .authorization((allow) => [
        allow.authenticated().to(["read"]),
        allow.groups(["ADMIN"]),
      ]),

    /**
     * One row per website lead, holding the state of its auto-reply window.
     *
     * The window is what makes "wait for their documents, then reply once"
     * possible without trusting the browser. A visitor who uploads nothing gets
     * the reply 8 minutes after submitting; one who uploads gets it 8 minutes
     * after their last upload, or as soon as they say they are done. The
     * browser can only ever *bring the deadline forward* — `dueAt` lives here
     * and the sweep is what reads it, so a closed laptop, a dead beacon or a
     * hostile caller cannot stop the reply going out.
     *
     * `uploadToken` is an unguessable secret handed back by `submitWebLead` and
     * required by both public mutations. It is the only thing standing between
     * an anonymous caller and someone else's lead, which is why it is indexed
     * (looked up by token, never by account) and never returned by a query.
     *
     * Nobody reads or writes this from the app — the three Lambdas are the only
     * authors. Read is open to a signed-in user so a producer can see why a
     * reply has not gone out yet.
     */
    LeadReply: a
      .model({
        accountId: a.id().required(),
        contactEmail: a.string().required(),
        contactName: a.string(),
        status: a.ref("LeadReplyStatus").required(),
        /** Secret for the two public mutations. */
        uploadToken: a.string().required(),
        submittedAt: a.datetime().required(),
        /** When the window closes. Pushed out by each upload, pulled in by a
         *  "done" signal. The sweep sends once this is in the past. */
        dueAt: a.datetime().required(),
        uploadCount: a.integer(),
        lastUploadAt: a.datetime(),
        /** Set when the visitor said they were finished, or their tab went away. */
        closedAt: a.datetime(),
        sentAt: a.datetime(),
        /**
         * Exactly what went out, kept so a producer can answer "what did we
         * tell this lead?" without digging through a mailbox. The body is
         * generated, so the record of it is the only account of what the agency
         * said — worth storing even though the team is BCC'd.
         */
        sentSubject: a.string(),
        sentBody: a.string(),
        /** Why the reply did not go, or went without document context. */
        note: a.string(),
      })
      .secondaryIndexes((index) => [index("uploadToken")])
      /**
       * ADMIN only, and nothing in the app reads this model at all.
       *
       * `uploadToken` is a bearer credential: possession of it is the entire
       * authorization for `requestLeadUpload`. Readable by every authenticated
       * user it was pure surface with no benefit — staff can already write
       * Documents to any account directly, so the token granted them nothing,
       * but it would become a real escalation the moment PRODUCER is scoped to
       * its own accounts. The Lambdas reach this over IAM, which model rules do
       * not apply to.
       */
      .authorization((allow) => [allow.groups(["ADMIN"]).to(["read"])]),

    /**
     * A lead's document upload link, and what it has collected.
     *
     * ── Why this is not `LeadReply.uploadToken` ──────────────────────────────
     * That token means one thing: hold the auto-reply open, and close when the
     * deadline passes. `decide.ts` consumes it and the reply going out ends it.
     * A document request is the opposite shape — it is *created* by the reply
     * going out, has no deadline, and has to keep working for weeks while a
     * board finds its paperwork. Reusing one token for both would mean either
     * the reply waits sixty days or the link dies when the email sends.
     *
     * ── Why not a column on Account ─────────────────────────────────────────
     * A token needs its own index to be looked up by, and Account is the widest
     * table in the schema. It also needs to be revocable and reissuable without
     * writing to the account, and to carry its own counters — none of which
     * belongs beside the ACORD producer block.
     *
     * One live portal per account is the intent, not a constraint the schema
     * enforces: `uploadPortal` reuses an unexpired one and mints a new one
     * otherwise, so reissuing after sixty days leaves the old row in place as
     * history rather than overwriting it.
     *
     * Not readable with the API key. Every public path goes through the
     * `uploadPortal` function, which resolves the token itself — so a token is
     * never a way to list rows, only to act on the one it names.
     */
    UploadPortal: a
      .model({
        // Plain id, no `belongsTo` — same as LeadReply. A relationship would
        // need a matching `hasMany` on Account, and nothing traverses it: the
        // portal function reads the account by id, and the id is all the
        // checklist query needs.
        accountId: a.id().required(),
        /** Unguessable secret. The only thing the link carries. */
        token: a.string().required(),
        expiresAt: a.datetime().required(),
        /** Set when a producer kills a link early. Checked before expiry. */
        revokedAt: a.datetime(),
        /** For the "someone is sending things" notification, and the digest. */
        lastUploadAt: a.datetime(),
        /** Counted across every section, against PORTAL_MAX_FILES. */
        uploadCount: a.integer(),
        /**
         * The `lastUploadAt` the team was last told about.
         *
         * Compared against `lastUploadAt` rather than being a boolean, so a
         * second batch two days later notifies again and a sweep that runs every
         * minute does not notify fifteen times for fifteen loss runs.
         */
        notifiedUpTo: a.datetime(),
        /**
         * `updatedBy`, not `lastWriteBy`. That name is reserved for the models in
         * STREAMED_MODELS, and a test asserts there is exactly one per streamed
         * model and not one more. This is deliberately not streamed: `Document`
         * already is, so every portal upload is in the account's activity log
         * once, and streaming the portal row as well would log it twice.
         */
        updatedBy: a.string(),
      })
      .secondaryIndexes((index) => [index("token")])
      // Same reasoning as LeadReply, and this one was authenticated-*writable*:
      // any signed-in user could revoke or extend another account's portal.
      .authorization((allow) => [allow.groups(["ADMIN"]).to(["read", "update"])]),

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
        /**
         * Both are strings on this surface even though their columns are
         * `a.integer()` and `a.date()`, for the same reason `contactEmail` is:
         * a typed argument makes AppSync reject the whole mutation over one
         * malformed value, and losing a lead is worse than losing a field. The
         * handler parses them and files anything it cannot read into `notes`.
         */
        unitCount: a.string(),
        currentPolicyExpiration: a.string(),
        buildiumId: a.string(),
        source: a.string(),
        notes: a.string(),
      })
      .returns(a.json())
      .authorization((allow) => [allow.publicApiKey()])
      .handler(a.handler.function(leadIntake)),

    /**
     * Ask for somewhere to put a file. Public, and gated entirely by the
     * `uploadToken` from `submitWebLead` — no token, no upload.
     *
     * Returns a presigned S3 PUT plus the Document id it belongs to. The
     * presign is signed with the Lambda's own credentials, which is what lets
     * an unauthenticated visitor write into `documents/` without that prefix
     * being opened up: the object lands at the same key layout a staff upload
     * uses, so the OCR trigger and the Documents tab need no special case.
     *
     * Requesting an upload also pushes the reply window out — see LeadReply.
     */
    requestLeadUpload: a
      .mutation()
      .arguments({
        uploadToken: a.string().required(),
        filename: a.string().required(),
        contentType: a.string(),
        /**
         * Required, because it is signed into the presigned PUT.
         *
         * It used to be advisory: the handler checked it against the size limit
         * and then signed a URL that constrained nothing, so a caller could
         * declare a kilobyte and send five gigabytes. `Content-Length` is now
         * part of the signature, which makes a lie fail at S3 — but only if
         * there is a value to sign.
         */
        sizeBytes: a.integer().required(),
      })
      .returns(a.json())
      .authorization((allow) => [allow.publicApiKey()])
      .handler(a.handler.function(leadUpload)),

    /**
     * "I am done uploading" — or their tab went away. Brings the window's
     * deadline forward to now so the next sweep sends.
     *
     * Idempotent, and can only ever *shorten* the wait: there is deliberately
     * no public way to extend it, so the token cannot be used to hold a reply
     * open indefinitely.
     */
    closeLeadUploadWindow: a
      .mutation()
      .arguments({ uploadToken: a.string().required() })
      .returns(a.json())
      .authorization((allow) => [allow.publicApiKey()])
      .handler(a.handler.function(leadUpload)),

    /**
     * What one upload link is for: the association's name, the checklist, and
     * which parts of it have already arrived.
     *
     * A query rather than a mutation, and it deliberately returns nothing that
     * would help someone who guessed a token do anything with an account: the
     * display name, counts per section, and the expiry. No contact details, no
     * addresses, no document contents, no ids.
     */
    /**
     * NOT `getUploadPortal`. Declaring a model called `UploadPortal` makes
     * Amplify generate `getUploadPortal(id: ID!)` on Query, and a custom field
     * of the same name fails synth with "Object type extension 'Query' cannot
     * redeclare field getUploadPortal". Any custom field named
     * `get`/`list`/`create`/`update`/`delete` + a model name has the same
     * problem.
     */
    uploadPortalStatus: a
      .query()
      .arguments({ token: a.string().required() })
      .returns(a.json())
      .authorization((allow) => [allow.publicApiKey()])
      .handler(a.handler.function(uploadPortal)),

    /**
     * Somewhere to put one file, filed against the checklist section it came
     * from. Same presigned-PUT shape as `requestLeadUpload`.
     *
     * `documentKey` is a key from `shared/leadDocuments.ts`, not a category: the
     * caller says which question it is answering and the server decides what
     * that means, so a public caller cannot invent a category.
     */
    requestPortalUpload: a
      .mutation()
      .arguments({
        token: a.string().required(),
        documentKey: a.string().required(),
        filename: a.string().required(),
        contentType: a.string(),
        /** Required and signed into the PUT — see requestLeadUpload. */
        sizeBytes: a.integer().required(),
      })
      .returns(a.json())
      .authorization((allow) => [allow.publicApiKey()])
      .handler(a.handler.function(uploadPortal)),

    /**
     * W7: the finance election, from the invoice email's signed link. Public
     * for the association's board treasurer, thin for everyone else — the
     * token names a loan; every decision is re-made server-side from what
     * the tables say now. Terms renders the offer; accept closes the
     * pay-in-full paths, stamps the election, and returns a Stripe Checkout
     * URL for the down payment + ACH mandate. Advancing the loan itself is
     * the webhook's job, when the money actually moves.
     */
    financeElectionTerms: a
      .query()
      .arguments({ token: a.string().required() })
      .returns(a.json())
      .authorization((allow) => [allow.publicApiKey()])
      .handler(a.handler.function(pfElection)),

    acceptFinanceElection: a
      .mutation()
      .arguments({
        token: a.string().required(),
        /** The dispatch discriminator — see lead-upload/dispatch.ts. */
        accept: a.boolean().required(),
        /**
         * W8: the agreement's execution — a typed name and role, required
         * by the handler before any Checkout Session exists. Optional here
         * only because a revived link (failed debit) is already signed.
         */
        signerName: a.string(),
        signerRole: a.string(),
      })
      .returns(a.json())
      .authorization((allow) => [allow.publicApiKey()])
      .handler(a.handler.function(pfElection)),

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

    /**
     * The next invoice number. Atomic — see functions/invoice-number.
     *
     * Reserved when an invoice is created rather than when it is sent, so a
     * voided draft leaves a gap in the sequence. Gaps are explainable; a number
     * handed out twice is not.
     */
    reserveInvoiceNumber: a
      .mutation()
      .returns(a.json())
      .authorization((allow) => [allow.authenticated()])
      .handler(a.handler.function(invoiceNumber)),

    /**
     * Email an invoice to the insured.
     *
     * Takes an id, not amounts: the figures are read from the rows server-side.
     * The browser has already computed the same totals for the screen, but this
     * email is a demand for money and the number in it comes from the database.
     *
     * `toEmail` overrides the account's primary contact, for the case where the
     * bill goes to a management company rather than to the board.
     */
    sendInvoice: a
      .mutation()
      .arguments({ invoiceId: a.string().required(), toEmail: a.string() })
      .returns(a.json())
      .authorization((allow) => [allow.authenticated()])
      .handler(a.handler.function(sendInvoice)),

    /**
     * Retire an invoice, and the payment link with it.
     *
     * A mutation rather than a status write from the browser because
     * deactivating the Stripe link needs the secret key. See the function's
     * resource.ts for what leaving the link alive costs.
     */
    voidInvoice: a
      .mutation()
      .arguments({ invoiceId: a.string().required() })
      .returns(a.json())
      .authorization((allow) => [allow.authenticated()])
      .handler(a.handler.function(voidInvoice)),

    /**
     * Flip the premium-finance module, with the flip logged in the same
     * breath. ADMIN only — this is the kill switch on a lending product, and
     * the reason it is a mutation rather than a settings write is that the
     * log row and the flag change come from one Lambda and cannot come apart.
     */
    setPremiumFinanceEnabled: a
      .mutation()
      .arguments({ enabled: a.boolean().required() })
      .returns(a.json())
      .authorization((allow) => [allow.groups(["ADMIN"])])
      .handler(a.handler.function(pfAdmin)),

    /**
     * Originate a premium finance quote — the control point.
     *
     * Re-runs everything server-side whatever the UI showed: the module flag,
     * the jurisdiction gate, the APR cap (a request above the cap is rejected
     * by this API, not just disabled in a browser), the minimum principal,
     * and all four eligibility screens. Writes one PfComplianceLog row per
     * rule evaluated, pass or block, each carrying the ruleset SHA — and only
     * on all-pass creates the PfLoan.
     */
    issueFinanceQuote: a
      .mutation()
      .arguments({
        policyId: a.string().required(),
        premium: a.float().required(),
        downPct: a.float().required(),
        months: a.integer().required(),
        apr: a.float().required(),
        effectiveDate: a.string().required(),
      })
      .returns(a.json())
      .authorization((allow) => [allow.authenticated()])
      .handler(a.handler.function(pfOriginate)),

    /**
     * Render the agreement + board resolution for a quoted loan, from the
     * loan's FROZEN terms, filed through Documents. The staleness rule for
     * the executed resolution is enforced at activation, not here — this
     * generates the paper the board has not signed yet.
     */
    generatePfAgreement: a
      .mutation()
      .arguments({ loanId: a.string().required() })
      .returns(a.json())
      .authorization((allow) => [allow.authenticated()])
      .handler(a.handler.function(pfAgreement)),

    /**
     * Everything that happens to a loan after issuance, in one Lambda-backed
     * mutation dispatched on `action`: ACTIVATE (with the board-resolution
     * staleness rule), POST_PAYMENT (split from the frozen schedule, lending
     * account required), NOTICE_INTENT, RECORD_CERT, REQUEST_CANCELLATION
     * (refused until intent + certificate + 15 days). The origination gate is
     * deliberately absent from all of it: we cannot un-lend.
     */
    servicePfLoan: a
      .mutation()
      .arguments({
        loanId: a.string().required(),
        action: a.string().required(),
        boardResolutionExecutedAt: a.string(),
        boardResolutionDocumentId: a.string(),
        noticeId: a.string(),
        certMailedAt: a.string(),
        certNumber: a.string(),
        cancellationEffectiveAt: a.string(),
        /** W8 BIND_ROLLOVER: the policy the quote just became. */
        policyId: a.string(),
      })
      .returns(a.json())
      .authorization((allow) => [allow.authenticated()])
      .handler(a.handler.function(pfServicing)),
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
    // The daily operations rollup reads across most models and writes nothing
    // at all. Like the digests above the grant is API-wide, so read-only is a
    // property of the handler rather than something the schema holds it to.
    allow.resource(opsRollup),
    // Public lead uploads: reads the LeadReply the token names, creates a
    // Document and moves the window's deadline. Writes nothing else.
    allow.resource(leadUpload),
    // The auto-reply sweep reads LeadReply, the Account and its Documents,
    // and marks the reply sent.
    allow.resource(leadReply),
    // The upload portal resolves link tokens and writes Documents for them.
    allow.resource(uploadPortal),
    // The notification sweep reads portals, accounts and documents, and stamps
    // `notifiedUpTo` so a batch is reported once.
    allow.resource(portalSweep),
    // Reads invoices, lines, accounts and contacts to build the emailed bill.
    allow.resource(sendInvoice),
    /**
     * Premium finance. Origination reads Account/Policy/PfOverride/settings
     * and creates PfLoan; the agreement renderer reads the loan tree and
     * creates Document rows; servicing writes loans, payments and notice
     * rows; the default sweep marks missed loans. All four write their
     * decision rows to the compliance-log table directly, not through here —
     * that model takes no data-client writes from anything.
     */
    allow.resource(pfOriginate),
    allow.resource(pfAgreement),
    allow.resource(pfServicing),
    allow.resource(pfDefaultSweep),
    // The public election endpoint resolves loan tokens, reads the account
    // name, the kill switch, and the policy's invoices; its writes (the
    // election stamp, the compliance row, the void) go direct to tables.
    allow.resource(pfElection),
    // The autopay cron reads ACTIVE loans; its claim/marker writes are
    // conditional and go direct to the loan table.
    allow.resource(pfAutopay),
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
