# SPEC — Lead/Client expansion

Status: **approved for research + implementation**, not yet started.
Target: `crm/` only (`web/` is untouched except where noted in W1).
Written against `staging` @ `d73971c`.

This document is the contract for a set of changes that other sessions will
research and build. Each workstream (W0–W9) is independently reviewable and
lands as its own commit on `staging`. Read [Ground rules](#ground-rules) before
writing any code — this repo has a written convention set and an audit that
already names the mistakes not to repeat.

---

## Contents

- [Ground rules](#ground-rules)
- [Decisions already made](#decisions-already-made)
- [Dependency order](#dependency-order)
- [W0 — Shared groundwork](#w0--shared-groundwork)
- [W1 — Contacts](#w1--contacts)
- [W2 — Overview: entity type + annual revenue](#w2--overview-entity-type--annual-revenue)
- [W3 — Prior Carrier tab](#w3--prior-carrier-tab)
- [W4 — Property restructure: blankets, GL, D&O](#w4--property-restructure-blankets-gl-do)
- [W5 — Buildings: editable + full underwriting detail](#w5--buildings-editable--full-underwriting-detail)
- [W6 — Losses tab](#w6--losses-tab)
- [W7 — Activity log](#w7--activity-log)
- [W8 — AI document filler](#w8--ai-document-filler)
- [W9 — Extraction duplicate prevention](#w9--extraction-duplicate-prevention)
- [Migration and rollout](#migration-and-rollout)
- [Verification](#verification)
- [Open questions](#open-questions)

---

## Ground rules

These are not suggestions. `docs/audit/PATTERNS.md` documents each one with the
bug it exists to prevent; `docs/audit/INVENTORY.md` ranks what is currently
wrong. Every workstream below assumes them.

1. **Schema enums are derived, never re-typed.** Any `a.enum(...)` added in
   `crm/amplify/data/resource.ts` gets its labels and option list in
   `crm/src/lib/enums.ts`, pinned with `satisfies Record<TheEnum, …>`, and
   ordered lists derived by sorting. Add the corresponding assertions to
   `crm/src/lib/enums.test.ts`. This spec adds ~8 enums — that is 8 tables in
   `enums.ts`, zero hand-written `<option>` lists.
2. **One async read, one `useAsyncResource`.** No `useState` + `useEffect` +
   `.then(setX)`. Use the loading → error → empty → content ladder verbatim.
3. **A client permission gate is never introduced alone.** Any new model that
   the UI restricts must carry the matching `.authorization()` rule.
4. **Backend code is type-checked before it deploys** — `npm run typecheck`
   covers both halves; run it before every commit.
5. **Use the primitives that already exist.** `formCodec.ts` (`str` / `num` /
   `inputValue`) and `storage.ts` are written, tested, and have **zero
   callers** (INVENTORY §1.1). New code in this spec must use them. Do not
   hand-roll `x.trim() || null`, `x ? Number(x) : null`, `uploadData`, or a
   download-to-tab helper.
6. **Use `listAllPages` for every list read.** A bare `.list()` silently
   truncates past ~100 scanned rows (INVENTORY §1.3).
7. **Never drop `errors` from an Amplify write.** Every `{ data, errors }`
   is checked and surfaced through `useSaveStatus`.

---

## Decisions already made

| Question | Decision |
|---|---|
| AI document filler vs. the existing deterministic pdf-lib mapping | **Deterministic first, AI fills the gaps.** The hand-mapped candidate lists stay authoritative. AI only proposes values for fields the mapping left empty, and every AI-assigned value is shown to the user. See [W8](#w8--ai-document-filler). |
| Account-level `yearBuilt` / `stories` / `constructionType` / system-update years | **Move to `Building`; ACORD reads buildings.** The Account columns are dropped after backfill. ACORD 140 becomes per-building, and the operations summary derives construction and storeys from the building rows. See [W4](#w4--property-restructure-blankets-gl-do) and [W5](#w5--buildings-editable--full-underwriting-detail). |
| Activity log capture | **DynamoDB Streams → Lambda**, as the system of record. See [W7](#w7--activity-log) — including the one thing streams cannot do alone (actor attribution). |
| Existing data in the fields being replaced | **One-time backfill script**, run and verified *before* the old columns are removed from the schema. See [Migration and rollout](#migration-and-rollout). |

---

## Dependency order

```
W0  Shared groundwork ─────────────┐
                                   ├──> W1 Contacts ────┐
                                   ├──> W2 Overview     │
                                   ├──> W3 Prior carrier├──> W8 AI filler
                                   ├──> W4 Property/GL/D&O
                                   ├──> W5 Buildings ───┘
                                   ├──> W6 Losses
                                   └──> W7 Activity log   (independent, can run in parallel)

W9 Extraction dedupe — after whichever of W1/W3/W5/W6 it must dedupe against.
```

W0 blocks everything: six of the workstreams are "a table of child rows with
add / edit / delete", and building that six times is exactly the class of
duplication the audit ranks #1.

W8 comes last because it needs the full data shape to build its account bundle.

---

## W0 — Shared groundwork

Nothing user-facing. Three primitives, each with tests, each with at least one
consumer migrated in the same commit so it does not join the dead-primitive
list.

### W0.1 — Formatted inputs

Covers the requirement *"For all input fields, ensure we do proper formatting
in the UI. Phone #, dollar amounts, etc."*

Today `client.ts` has `fmtNum` / `fmtMoney` / `fmtDate` for **display only**.
Every editable numeric is a raw `<input type="number">`, so a $4.2M total
insured value is typed and shown as `4200000`.

Create `crm/src/components/inputs/` with controlled components that render a
formatted string and hand back the raw value:

| Component | Renders | Hands back | Stores via |
|---|---|---|---|
| `MoneyInput` | `1,234,567` (no cents unless typed) | digit string | `num()` |
| `PercentInput` | `80%` | digit string | `num()` |
| `IntegerInput` | `1,234` | digit string | `num()` |
| `YearInput` | `1985` (no separator) | digit string | `num()` |
| `PhoneInput` | `(555) 123-4567` | digits | `str()` |
| `DateInput` | native `type="date"` | ISO day | `str()` |

Rules:

- Formatting is applied on blur, not on every keystroke — an on-keystroke mask
  fights the caret. While focused, show the raw digits.
- **Phone storage:** the column stays a freeform `a.string()`. The schema
  comment at `crm/amplify/data/resource.ts:118` explains why (`a.phone()` only
  accepts E.164). `PhoneInput` normalises a 10-digit US entry to
  `(555) 123-4567` on save and stores anything else verbatim — extensions and
  international numbers must survive untouched.
- **Money storage stays a plain number.** No cents rounding in the component;
  `fmtMoney` already renders with `maximumFractionDigits: 0`.
- Each component takes the same props (`value`, `onChange`, `disabled`,
  `placeholder`) so swapping one for another in a form is a one-word edit.

Also add the display counterpart `fmtPhone(v)` next to `fmtMoney` in
`client.ts`, and use it in every read-only phone render.

**Migrate at least `OverviewTab.tsx` and `DetailsCard.tsx` in this commit.**

### W0.2 — The child-rows primitive

Contacts, prior carriers, blankets, GL class codes, losses, D&O coverage parts
and buildings are all the same screen: a paginated list of child rows belonging
to one account, with add, edit and delete.

`BuildingsCard.tsx` is the closest thing today and it is add-only — there is no
edit path anywhere in the app for a child row.

Build `crm/src/lib/useChildRows.ts`:

```ts
useChildRows<T>(model, { accountId, initialForm, toCreate, toUpdate })
  → { rows, loaded, error,        // via useAsyncResource + listAllPages
      addStatus, editStatus, delStatus,   // three useSaveStatus instances
      add, startEdit, cancelEdit, saveEdit, remove, editingId }
```

Requirements:

- Reads through `useAsyncResource` + `listAllPages`, filtered on `accountId`.
- Add / edit / delete each check `{ data, errors }` and route the result
  through `useSaveStatus`, following `BuildingsCard`'s existing split:
  add/edit confirmations are **persistent** (the row is on screen), delete
  confirmations **auto-clear** after 4s (the row it names is gone).
- Delete is always behind `ConfirmButton`.
- Optimistic local patch on success, never a refetch.

Render pattern: a `<ChildRowsCard>` shell that takes a column definition and an
edit-form renderer. Rows with ≤5 fields edit inline; rows with more (buildings,
GL class codes) edit in the existing `Modal.tsx`.

### W0.3 — `unwrap`

INVENTORY §1.2: 36 sites spell the `{ data, errors }` check three different
ways and 10 of them do not throw. Add to `crm/src/lib/client.ts`:

```ts
/** Throws on GraphQL errors or a null payload; returns the data. */
export function unwrap<T>(r: { data: T | null; errors?: { message: string }[] }): T
```

All new code in W1–W9 uses it. Migrating the existing 36 is out of scope here.

---

## W1 — Contacts

**Requirement.** Move inspection contact info and other contact info into its
own tile, with multiple contacts per lead/client. Fields: name, email, phone,
type (Inspection, claims, accounting, manager, trustee, director, president),
notes.

### Schema

```ts
ContactType: a.enum([
  "INSPECTION", "CLAIMS", "ACCOUNTING", "MANAGER",
  "TRUSTEE", "DIRECTOR", "PRESIDENT", "OTHER",
]),

Contact: a.model({
  accountId: a.id().required(),
  account: a.belongsTo("Account", "accountId"),
  name: a.string().required(),
  email: a.email(),
  phone: a.string(),          // freeform — see W0.1
  type: a.ref("ContactType"),
  notes: a.string(),
  // Exactly one per account. The ACORD insured block and the COI use this
  // one; without it there is no answer to "which of five contacts is the
  // applicant's phone number".
  isPrimary: a.boolean(),
  extractionSourceKey: a.string(),   // see W9
}),
```

`OTHER` is added beyond the requested list because carriers ask for roles the
list does not cover (property manager's assistant, on-site super). Flagged in
[Open questions](#open-questions).

### Account columns removed

`contactFirstName`, `contactLastName`, `contactEmail`, `contactPhone`,
`inspectionContactName`, `inspectionContactPhone`.

### UI

- New `ContactsCard` on the Overview tab, above the Property panel, built on
  `useChildRows`.
- `isPrimary` is a radio, not a checkbox: setting it on one row clears it on
  the others in the same write batch.
- Contacts render `fmtPhone`; the edit form uses `PhoneInput`.

### Callers that must change

| File | Today | Becomes |
|---|---|---|
| `crm/src/lib/acordApp.ts` (125 block) | `account.inspectionContactName` / `…Phone` → `NamedInsured_Contact_*` | first `Contact` with `type === "INSPECTION"`; `inspectionLabel` still ticks only when one exists |
| `crm/src/lib/acordApp.ts` (shared header) | `account.contactPhone` → `NamedInsured_Primary_PhoneNumber_A` | the `isPrimary` contact's phone, falling back to the first contact |
| `crm/src/lib/acord25.ts` | check for insured-contact usage during implementation | same primary-contact rule |
| `crm/src/components/ExtractionPanel.tsx` | patches four `contact*` columns on Account | creates/updates a `Contact` row (see W9 for the dedupe rule) |
| `crm/amplify/functions/extract-lead/handler.ts` | extracts `contactFirstName`/`contactLastName`/… as flat fields | extract a `contacts[]` array of `{ name, email, phone, type }`, mirroring the existing `buildings[]` array |
| `crm/amplify/functions/lead-intake/handler.ts` | writes `contactFirstName` etc. onto the new Account | creates the Account, then creates one primary `Contact` from the same arguments |
| `crm/src/pages/NewLead.tsx` | contact fields on the create form | create the Account, then the primary Contact |

**The public `submitWebLead` mutation signature does not change.** Its
arguments (`contactFirstName`, `contactEmail`, …) are a deployed contract with
`web/` and with protectmyhoa.com's forms; only the handler's behaviour changes.
This is the one thing in this spec that breaks the marketing site if it is
done wrong.

`lead-intake` now does two writes where it did one. If the Contact create
fails, the Account must still exist and the failure must be logged — a web lead
that 500s because a contact row failed is worse than a lead with no contact.

### Backfill

Per account: one `Contact` from `contactFirstName + contactLastName /
contactEmail / contactPhone` (`isPrimary: true`, `type: OTHER`), and one from
`inspectionContactName / inspectionContactPhone` (`type: INSPECTION`). Skip
either when every source field is blank. Idempotent on
`extractionSourceKey = "backfill:contact"` / `"backfill:inspection"`.

---

## W2 — Overview: entity type + annual revenue

**Requirement.** Add Entity Type and Annual Revenue to the Overview.

### Schema

```ts
// ACORD 125 applicant "Legal Entity" checkboxes. Same shape as
// AGGREGATE_APPLIES_TO in enums.ts: the label and the PDF field it ticks
// live in one table so the dropdown and the mapping cannot offer
// different member sets.
LegalEntityType: a.enum([
  "CORPORATION", "INDIVIDUAL", "JOINT_VENTURE", "LLC",
  "NOT_FOR_PROFIT", "PARTNERSHIP", "SUBCHAPTER_S_CORP", "TRUST",
]),
```

On `Account`:

```ts
legalEntityType: a.ref("LegalEntityType"),
annualRevenue: a.float(),
```

### enums.ts

Add `LEGAL_ENTITY` table carrying `{ label, acord125Field }` per member,
exactly like `AGGREGATE_APPLIES_TO` at `crm/src/lib/enums.ts:178`. Export
`LEGAL_ENTITY_OPTIONS` and `ACORD125_LEGAL_ENTITY_FIELDS`.

### ACORD impact

`crm/src/lib/acordApp.ts` currently hardcodes the not-for-profit box:

```ts
notForProfit: {
  candidates: ["NamedInsured_LegalEntity_NotForProfitIndicator_A"],
  value: account.type === "ASSOCIATION" ? "x" : "",
},
```

Replace with a lookup through `ACORD125_LEGAL_ENTITY_FIELDS`, defaulting to
`NOT_FOR_PROFIT` when the field is unset **and** `account.type ===
"ASSOCIATION"`, so existing accounts keep filling the same box.

`annualRevenue` maps to the 125's gross-revenue field. The exact field name
must be read off a real template with **Settings → Inspect fields** — do not
guess it into the candidate list. Candidates that match nothing are reported in
`FillResult.missing`, so a wrong guess fails silently-ish rather than loudly.

### UI

Both fields go in `OverviewTab.tsx`'s Details card. `annualRevenue` uses
`MoneyInput`.

---

## W3 — Prior Carrier tab

**Requirement.** A new tab holding prior carrier / policy # / premium /
effective dates, moved off Details, supporting multiple rows, with a line of
business per row. Hidden once the account converts to a client.

### Schema

```ts
PriorCarrier: a.model({
  accountId: a.id().required(),
  account: a.belongsTo("Account", "accountId"),
  carrierName: a.string(),
  policyNumber: a.string(),
  lineOfBusiness: a.string(),   // LINES_OF_BUSINESS vocabulary (client.ts:91)
  premium: a.float(),
  effectiveDate: a.date(),
  expirationDate: a.date(),
  extractionSourceKey: a.string(),   // see W9
}),
```

`lineOfBusiness` is a `string`, not an enum, because `LINES_OF_BUSINESS` is
already a plain array with no schema counterpart — PATTERNS explicitly lists it
under "where the rule does not apply".

### Account columns removed

`priorCarrierName`, `priorPolicyNumber`, `priorPremium`, `priorTermEffective`,
`priorTermExpiration`.

### UI

- New tab in `crm/src/pages/AccountDetail.tsx`. Extend the `Tab` union and
  `VALID_TABS` at lines 23–31 and the label array at lines 91–98.
- **The tab is hidden when `account.stage === "CLIENT"`.** Hidden, not deleted:
  the rows stay in the table and keep feeding the ACORD prior-coverage block on
  renewal submissions. If someone lands on `?tab=priorcarrier` for a client,
  fall back to `overview` rather than rendering an empty tab.
- Table columns: line of business, carrier, policy #, premium, effective,
  expiration. Sorted by expiration descending via `useSort`.

### ACORD impact

`acordApp.ts`'s 125 block fills a single GL prior-coverage row from the five
Account columns. The 125 has one prior-coverage row **per line** — the current
mapping only ever filled the GL one.

New behaviour: for each `PriorCarrier` row, fill the prior-coverage row whose
line matches (`PriorCoverage_GeneralLiability_*`,
`PriorCoverage_CommercialProperty_*`, …). The exact per-line field prefixes
must be confirmed with **Settings → Inspect fields**; add a
`PRIOR_COVERAGE_FIELDS: Record<string, string>` map from the CRM's line
vocabulary to the ACORD prefix, in the same shape as the existing `LOB_FIELDS`
map in `acordApp.ts`.

`values.policyNumber` on the 125 (`Policy_PolicyNumberIdentifier_A`) currently
falls back to `account.priorPolicyNumber`. It becomes the policy number of the
prior-carrier row matching the line being applied for, or blank.

### Backfill

One `PriorCarrier` row per account where any of the five columns is non-blank,
`lineOfBusiness: "General Liability"` (that is the block those columns fed).
Idempotent on `extractionSourceKey = "backfill:priorcarrier"`.

---

## W4 — Property restructure: blankets, GL, D&O

### W4.1 — Fields removed from the Property card

Delete from `Account` **and** from `DetailsCard.tsx`: `yearBuilt`, `stories`,
`constructionType`, `roofUpdatedYear`, `hvacUpdatedYear`,
`electricalUpdatedYear`, `plumbingUpdatedYear`.

`otherUpdates`, `firewallsVerified`, `coastal` and `milesToCoast` are **not**
in the removal list and stay on the Account — they are site-level, not
building-level. Confirm before deleting anything not named here.

The whole "System updates (year completed)" section of `DetailsCard.tsx`
(lines 226–269) goes away; `otherUpdates` moves up into the main grid.

Downstream, in the same commit:

| Site | Change |
|---|---|
| `acordApp.ts` `operationsSummary()` | derives storeys and construction from the buildings (most common value across rows), not from the Account |
| `acordApp.ts` 140 block | per-building — see [W5](#w5--buildings-editable--full-underwriting-detail) |
| `acordApp.ts` 125 premises rows | already reads buildings; `Construction_BuildingArea_*` unchanged |
| `extract-lead/handler.ts` | the seven fields move out of the flat `EXTRACTION_SCHEMA` and into the per-building objects in the `buildings[]` array |
| `ExtractionPanel.tsx` | the seven `FieldDef` entries are removed; buildings gain the fields in their own review rows |
| `client.ts` `validateAccountFields` | drop the `yearBuilt` branch; add the equivalent to the building validator |

### W4.2 — Fire District

`Account.fireDistrict: a.string()` — freeform text, on the Property card.

### W4.3 — Blanket coverages (multiple)

```ts
Blanket: a.model({
  accountId: a.id().required(),
  account: a.belongsTo("Account", "accountId"),
  blanketNumber: a.string(),
  amount: a.float(),
  type: a.string(),    // freeform per the requirement
  extractionSourceKey: a.string(),
}),
```

`useChildRows` card on the Property tab. `amount` uses `MoneyInput`.

`Building.blanketNumber` (W5) is a **free-text string**, not a foreign key to
`Blanket`. Rationale: the ACORD forms print the number the underwriter wrote,
deleting a blanket must not orphan a building, and the numbers come off prior
policy declarations rather than being generated here. The building edit form
offers the account's existing blanket numbers via a `<datalist>` so the common
case is a click, and typing a number that has no `Blanket` row is legal.

`Quote.blanketLimit` and `Policy.blanketLimit` are a **different concept** —
they are quoted/bound terms, not the application's blanket schedule. Leave them
alone.

### W4.4 — General Liability section

This is application data (what is carried / applied for, ACORD 126 input), not
quoted terms. `Quote`/`Policy` already carry `gl*` columns for what a carrier
quoted — do not conflate them.

`Account` is already ~50 columns. GL goes in its own 1:1 model:

```ts
GlDeductibleType: a.enum(["PER_OCCURRENCE", "PER_CLAIM"]),
GlPremiumBasis:   a.enum(["UNIT", "OTHER"]),

GlApplication: a.model({
  accountId: a.id().required(),
  account: a.belongsTo("Account", "accountId"),   // Account gains hasOne

  // ── Limits ──
  eachOccurrence: a.float(),
  generalAggregate: a.float(),
  limitAppliesPer: a.ref("AggregateAppliesTo"),   // existing enum — see below
  productsCompletedOpsAggregate: a.float(),
  personalAdvInjury: a.float(),
  damageToRentedPremises: a.float(),
  medicalExpense: a.float(),

  // ── Deductibles ──
  deductibleType: a.ref("GlDeductibleType"),
  propertyDamageDeductible: a.float(),
  bodilyInjuryDeductible: a.float(),

  // ── Sub-contractors ──
  usesSubcontractors: a.boolean(),
  subsCarryLowerLimits: a.boolean(),
  subsAllowedWithoutCoi: a.boolean(),
  subcontractedWorkDescription: a.string(),
  paidToSubcontractors: a.float(),
  workSubcontractedPct: a.float(),
  fullTimeEmployees: a.integer(),
  partTimeEmployees: a.integer(),
}),

GlClassCode: a.model({
  accountId: a.id().required(),
  account: a.belongsTo("Account", "accountId"),
  hazardNumber: a.string(),
  classCode: a.string(),
  premiumBasis: a.ref("GlPremiumBasis"),
  exposure: a.float(),
  description: a.string(),
}),
```

**`limitAppliesPer` reuses the existing `AggregateAppliesTo` enum** rather than
declaring a two-member `LOCATION | POLICY` twin. The requirement names only
Location and Policy; the existing enum also offers Project and Other, and it is
already wired to the ACORD 25 checkboxes through `ACORD25_AGGREGATE_FIELDS`.
Two enums for one concept is exactly the drift PATTERNS forbids. Flagged in
[Open questions](#open-questions) in case the extra members are unwanted.

UI: a "General Liability" section on the Property tab — one form card for
`GlApplication` (created lazily on first save), one `useChildRows` table for
`GlClassCode`. The three sub-contractor booleans are Yes/No radios, not
checkboxes: "No" and "not answered" are different answers on an application,
and a checkbox cannot express the difference.

ACORD 126 mapping is currently an empty branch in `acordApp.ts`
(`if (formKey === "acord126") { }`). Filling it is part of this workstream:
add `"acord126"` to `MAPPED_APP_FORM_KEYS` only once the mapping exists,
because that set is what enables the Generate button.

### W4.5 — D&O section

Parts A, B and C carry identical field sets, so they are three rows of one
model rather than 12 columns:

```ts
DoPart:         a.enum(["A", "B", "C"]),
DoCoverageType: a.enum(["PRIMARY", "EXCESS"]),
DefenseLimitPosition: a.enum(["INSIDE", "OUTSIDE"]),

DoCoveragePart: a.model({
  accountId: a.id().required(),
  account: a.belongsTo("Account", "accountId"),
  part: a.ref("DoPart").required(),
  coverageType: a.ref("DoCoverageType"),
  perClaimLimit: a.float(),
  aggregateLimit: a.float(),
  perClaimRetention: a.float(),
  aggregateRetention: a.float(),
}),

DoApplication: a.model({
  accountId: a.id().required(),
  account: a.belongsTo("Account", "accountId"),
  separateDefenseLimit: a.boolean(),
  defenseLimit: a.float(),
  defenseLimitPosition: a.ref("DefenseLimitPosition"),
  pendingPriorLitigationDate: a.date(),
}),
```

UI: a "Directors & Officers" section on the Property tab rendering exactly
three fixed rows (A, B, C), created on demand. It is not an add/remove table —
the parts are fixed by the form.

This feeds ACORD 810 (already in the registry at `acordRegistry.ts:49`). Its
mapping is out of scope here; W8's AI filler covers it until someone writes
one.

---

## W5 — Buildings: editable + full underwriting detail

**Requirement.** Buildings must be editable, and gain the full ACORD 140
per-building field set.

### Schema

`Building` today has `label`, `sqft`, `streetAddress`, `description`. It gains:

```ts
BuildingDeductibleType: a.enum(["PER_OCCURRENCE", "OTHER"]),
CauseOfLoss:            a.enum(["SPECIAL", "BASIC", "BROAD"]),

// on Building:
distanceToHydrantFt:      a.integer(),
distanceToFireStationMi:  a.float(),
otherOccupancies:         a.string(),
roofType:                 a.string(),
roofYear:                 a.integer(),
yearBuilt:                a.integer(),
stories:                  a.integer(),
basements:                a.integer(),
constructionType:         a.ref("ConstructionType"),   // existing enum
heatingYear:              a.integer(),
wiringYear:               a.integer(),
plumbingYear:             a.integer(),
fireProtectionType:       a.string(),
sprinklerPct:             a.float(),
historicalLandmark:       a.boolean(),
sinkholeCoverageAccepted: a.boolean(),
mineSubsidenceCoverage:   a.boolean(),
remarks:                  a.string(),   // ACORD 101 overflow
individualBuildingValue:  a.float(),
coinsurancePct:           a.float(),
valuation:                a.ref("ReplacementCostType"),   // existing enum
deductibleType:           a.ref("BuildingDeductibleType"),
deductibleAmount:         a.float(),
blanketNumber:            a.string(),   // free text — see W4.3
causeOfLoss:              a.ref("CauseOfLoss"),
formsConditions:          a.string(),
extractionSourceKey:      a.string(),   // see W9
```

Two existing enums are reused rather than redeclared:

- **`valuation`** → `ReplacementCostType` (`RC` / `ERC` / `GRC`), whose labels
  in `enums.ts:163` already read "Replacement Cost" / "Extended Replacement
  Cost" / "Guaranteed Replacement Cost" — the three values the requirement
  names. Confirm "Extended **Value** Replacement Cost" and "Extended
  Replacement Cost" mean the same thing to this agency before relabelling.
- **`constructionType`** → the existing `ConstructionType` and its
  `CONSTRUCTION_OPTIONS`.

`Building` keeps the schema default `allow.authenticated()` — PATTERNS notes
`Building` is deliberately staff-deletable as normal work.

### UI

`BuildingsCard.tsx` is rewritten on `useChildRows`:

- The table stays compact: label, address, sq ft, year built, construction,
  IBV, and an Edit button. The other ~19 fields are not table columns.
- **Edit opens `Modal.tsx`** with the full field set, grouped:
  *Identity* (label, address, description) · *Construction* (year built,
  stories, basements, construction type, roof type/year, heating/wiring/
  plumbing years) · *Protection* (distance to hydrant, distance to fire
  station, fire protection type, sprinkler %) · *Coverage* (IBV, valuation,
  coinsurance %, deductible type/amount, blanket #, cause of loss, forms &
  conditions) · *Other* (other occupancies, historical landmark, sinkhole,
  mine subsidence, remarks).
- Validation reuses `validateYear` for the five year fields (`maxYearsAhead: 1`
  for the update years, `5` for `yearBuilt` — the reasoning is documented at
  `client.ts:270`) and `validatePositiveInt` for the counts.
- Money fields use `MoneyInput`, percentages `PercentInput`.

### ACORD 140

The 140 is a property section **per building**, and today `acordApp.ts` fills a
single one from Account columns that are about to be deleted. Rework:

- `buildAppFormValues("acord140", …)` takes the building being described and
  fills `Construction_*`, `BuildingImprovement_*` and
  `CommercialProperty_Premises_*` from that row.
- An account with N buildings generates N PDFs, named
  `ACORD 140 — {label}.pdf`, all tracked as `ACORD_FORM` documents.
- Whether the template has multiple building sections per page (rows `A`/`B`
  like the 125's premises rows) must be read off a real template with
  **Settings → Inspect fields** before the loop is written. If it does, fill
  rows first and only start a second PDF when they run out — the same shape as
  `PREMISES_ROWS` in `acordApp.ts:26`.

Existing `BuildingImprovement_*` mappings move from `account.roofUpdatedYear`
etc. to `building.roofYear` / `heatingYear` / `wiringYear` / `plumbingYear`.

### Backfill

For every account with any of the seven removed Account columns set: if the
account has **no** buildings, create one (`label: "Building 1"`,
`streetAddress: account.address`) carrying them; if it has buildings, copy the
values onto **every** building that has the corresponding field empty. Both
paths idempotent on `extractionSourceKey`.

This is the one backfill that can produce wrong data — an account-level "roof
updated 2019" is not necessarily true of all 13 buildings. The script must
print a per-account summary and be reviewed before the columns are dropped.

---

## W6 — Losses tab

### Schema

```ts
Loss: a.model({
  accountId: a.id().required(),
  account: a.belongsTo("Account", "accountId"),
  dateOfLoss: a.date().required(),
  lineOfBusiness: a.string().required(),   // LINES_OF_BUSINESS
  description: a.string(),
  claimDate: a.date(),
  amountPaid: a.float(),
  amountReserved: a.float(),
  claimOpen: a.boolean(),
  amountOfLoss: a.float(),
  typeOfLoss: a.string(),
  extractionSourceKey: a.string(),   // see W9
}),
```

### UI

New "Losses" tab on `AccountDetail.tsx`, visible for both leads and clients
(loss history follows the account). `useChildRows` table sorted by date of loss
descending.

Client-side validation: date of loss and line of business are required; a claim
date before the date of loss is rejected via `validateDateRange`; amounts go
through `MoneyInput`.

Header summary: total paid, total reserved, open claim count — gated on
`loaded` (PATTERNS: never render an assertion about data you do not have yet).

### ACORD impact

The 125 has a loss-history section. Map the most recent rows to it, flag the
"Any losses?" indicator when any row exists, and tick the additional-remarks
attachment when there are more rows than the form has lines. Field names via
**Settings → Inspect fields**.

### Extraction

`LOSS_RUNS` is already a document category with extraction priority 3
(`enums.ts:240`). Add a `losses[]` array to `EXTRACTION_SCHEMA` so an uploaded
loss run populates the tab. Dedupe rule in W9.

---

## W7 — Activity log

**Requirement.** A tab under leads/clients holding a system log of every
activity done on the record.

**Decision:** DynamoDB Streams → Lambda, as the system of record.

### The thing to understand before starting

**A DynamoDB stream record does not say who wrote it.** The item image has no
actor: AppSync writes `createdAt` / `updatedAt`, and Amplify only stamps an
owner field on models using owner auth — none of these do. CloudTrail does not
cover data-plane DynamoDB writes at usable granularity.

So the streams approach gives complete, tamper-evident *change* capture and
**no attribution** on its own. To get "Jake changed the effective date", every
streamed model gains:

```ts
lastWriteBy: a.string(),   // Cognito sub of whoever made this write
```

set on every mutation by a thin client-side wrapper (extend `unwrap` from W0.3,
or add a sibling `write()` helper that injects it). The stream handler reads
`NewImage.lastWriteBy`, resolves it to a name against `UserProfile`, and
**excludes the field itself from the diff** so it never shows up as a change.
A write that arrives with no `lastWriteBy` is attributed to `"system"` — that
is the honest answer for a Lambda write (lead intake, extraction, renewal
sweep, OCR), and those Lambdas should set it to their own name explicitly.

This is the cost of the streams decision and it is worth stating in the commit
message: complete capture, attribution bolted on.

### Schema

```ts
ActivityAction: a.enum(["CREATE", "UPDATE", "DELETE"]),

Activity: a.model({
  // The ACCOUNT id for anything under an account — this is what the tab
  // queries. Mirrors Document's entityId GSI convention.
  entityId: a.string().required(),
  // What actually changed.
  subjectType: a.string().required(),   // "Building", "Quote", "Contact", …
  subjectId: a.string().required(),
  subjectLabel: a.string(),             // "Building A", "Quote — Travelers"
  action: a.ref("ActivityAction").required(),
  actor: a.string(),                    // Cognito sub, or "system"
  actorName: a.string(),                // resolved at write time
  changes: a.json(),                    // [{ field, from, to }]
  summary: a.string(),                  // one human sentence
  occurredAt: a.datetime().required(),
})
  .secondaryIndexes((index) => [index("entityId").sortKeys(["occurredAt"])])
  .authorization((allow) => [
    allow.authenticated().to(["read"]),
    allow.groups(["ADMIN"]),
    // writes come only from the stream handler, via allow.resource() at the
    // schema level — see the note at the foot of resource.ts
  ]),
```

`actorName` is resolved and denormalised at write time so the tab does not join
against `UserProfile` for every row, and so a renamed user does not rewrite
history.

### Backend wiring

One Lambda, `crm/amplify/functions/activity-log/`, with an event-source
mapping per streamed table. In Gen 2 the tables are reachable as
`backend.data.resources.tables["Account"]` in `crm/amplify/backend.ts`.

**Research first:** confirm whether Amplify Gen 2 enables streams with
`NEW_AND_OLD_IMAGES` by default (subscriptions need a stream, but the view type
matters — `OLD_IMAGE` is required for the diff and for delete records). If the
default view type is not `NEW_AND_OLD_IMAGES`, it must be overridden on the
CFN resource before any of this works.

Streamed models: `Account`, `Contact`, `PriorCarrier`, `Building`, `Blanket`,
`GlApplication`, `GlClassCode`, `DoApplication`, `DoCoveragePart`, `Loss`,
`Quote`, `Policy`, `Certificate`, `Document`.

**Not streamed:** `Activity` itself (would loop — and it has no mapping, so it
cannot), plus `Carrier`, `AppetiteGuide`, `MarketingTask`, `UserProfile`,
`License`, `ProducerLicense` — none of them hang off an account, and the tab is
account-scoped. Adding them later is one mapping each.

Handler rules:

1. Resolve `entityId`: `NewImage.accountId ?? OldImage.accountId`, except
   `Document` where it is `entityId` (already the account id for
   `entityType === "ACCOUNT"`). Records with no resolvable account are dropped.
2. Diff `OldImage` vs `NewImage`, excluding a noise list: `updatedAt`,
   `createdAt`, `lastWriteBy`, `aiExtraction`, `ocrText`, `ocrTables`,
   `__typename`, and `_version` / `_lastChangedAt` if present.
3. An `UPDATE` whose diff is empty writes nothing.
4. Build `summary` from the diff — "Effective date 1/1/2026 → 3/1/2026",
   "Added building Clubhouse", "Deleted quote".
5. Batch-write via `client.models.Activity.create` per record; failures are
   logged and the batch is not retried into a loop (set
   `bisectBatchOnFunctionError` off and a finite `retryAttempts`, or a poison
   record replays forever).

Cost: one Lambda invocation per batch per table. Set a batch window of a few
seconds so a form save producing 3 writes is one invocation.

### UI

New "Activity" tab on `AccountDetail.tsx` — a reverse-chronological timeline
read through `useAsyncResource` + `listAllPages` on the `entityId` index, with
`fmtDateTime` timestamps. Filters by subject type and by actor. Field diffs
render through the same formatters as the forms, so a money change reads
`$4,200,000 → $4,500,000`, not `4200000 → 4500000`.

---

## W8 — AI document filler

**Requirement.** Take all data for a client, hand it to an AI document filler
with a fillable PDF, get a filled PDF back. If a value is unknown, leave it
blank — **never** "pending info" or similar.

**Decision:** deterministic first, AI fills the gaps.

### Flow

1. The client fills the template deterministically exactly as today
   (`fillTemplate` in `crm/src/lib/acordPdf.ts`). Unchanged. Deterministic
   values can never be overwritten by the model.
2. New export in `acordPdf.ts`:

   ```ts
   /** Text fields still empty after a deterministic fill, and their labels. */
   export function emptyTextFields(pdf: PDFDocument): { name: string }[]
   ```

   `fillTemplate` returns them on `FillResult` so nothing re-parses the PDF.
3. The client calls a new mutation:

   ```ts
   suggestFormFields: a.mutation()
     .arguments({
       accountId: a.string().required(),
       formKey: a.string().required(),
       fieldNames: a.string().array().required(),
     })
     .returns(a.json())
     .authorization((allow) => [allow.authenticated()])
     .handler(a.handler.function(formFiller)),
   ```

4. `crm/amplify/functions/form-filler/` assembles the account bundle — account,
   contacts, prior carriers, buildings, blankets, GL application + class codes,
   D&O, losses, and active quotes/policies — and asks Claude to return
   `{ fieldName: value }` for the requested names only.
5. The handler sanitises before returning, and this is the part that carries
   the user's hard requirement:

   ```ts
   // Never emit a placeholder. A blank field on an ACORD form is a blank
   // field; "pending" is a factual claim the agency did not make.
   const PLACEHOLDER_RE =
     /^\s*(pending(\s+info(rmation)?)?|tbd|to be (determined|advised|provided)|n\/?a|unknown|none provided|see attached|refer to|various|\?+|-+)\s*$/i;
   ```

   Values matching it are dropped. So are values for field names not in the
   request, values over the field's max length, and anything the model returns
   for a field the deterministic pass already filled.
6. The client writes the surviving values into the same `PDFDocument` and
   shows an **"AI-filled fields"** list in the generation result panel — field
   name, value, and the model's one-line justification — so the producer
   verifies before sending. This list is not optional; it is what makes the
   feature safe to use on a document that goes to a carrier.

### Prompt rules (mirror `extract-lead`'s system prompt discipline)

- Every value is a string; `""` means "not supported by the data".
- Never infer, never round, never abbreviate a legal name.
- Dates as the form expects them (`fmtUs` in `acordFormat.ts` is the existing
  US-format helper).
- Return only the requested field names.
- Explicitly: *do not write "pending", "TBD", "N/A", "see attached", or any
  other placeholder — leave the value empty instead.*

### Model and cost

`extract-lead/handler.ts` pins `claude-opus-4-8`. Do not introduce a second,
different pin — extract the model id to one shared constant under
`crm/amplify/functions/` and have both handlers import it. Upgrading is then a
one-line change that moves both together. Check the latest Claude model ids
before pinning; do not carry forward an old id by default.

Consider prompt-caching the account bundle: generating a 125, a 126 and four
140s for the same account is six calls over the same data.

### Applies to the COI too

`CertificatesTab.tsx` generates ACORD 25 through `acord25.ts`. Same treatment:
deterministic fill, then gap-fill, then the AI-filled review list before the
PDF is stored. A certificate is the most consequential document the app
produces — the review list matters most here.

### What this does not change

`MAPPED_APP_FORM_KEYS` still gates which forms offer a Generate button on a
purely deterministic basis. AI gap-filling is an enhancement to a mapped form,
not a way to ship an unmapped one. If a form should be generatable with header
fields plus AI only, that is a deliberate separate decision.

---

## W9 — Extraction duplicate prevention

**Requirement.** "When applying data extract data it is possible to create
duplicates."

### The bug today

`crm/src/components/ExtractionPanel.tsx:245-259` creates a `Building` for every
selected row on **every** apply, with no check against what exists:

```ts
const buildings = (result.buildings ?? []).filter((_, i) => selectedBuildings[i]);
for (const [i, b] of buildings.entries()) {
  const { data: made, errors: bErrors } = await client.models.Building.create({ … });
}
```

Re-run an extraction and apply it again — which the UI invites, the button
reads "Re-run extraction" — and every building is duplicated. After W1/W3/W5/W6
the same code path will be creating contacts, prior carriers, losses and
blankets, so the blast radius grows fivefold.

### Fix

**1. A natural key per extractable model.** Every model created by extraction
gains `extractionSourceKey: a.string()`, holding a normalised key:

| Model | Key |
|---|---|
| `Building` | lowercased, whitespace-collapsed `label` |
| `Contact` | lowercased `email`, else `name` + `type` |
| `PriorCarrier` | `carrierName` + `policyNumber` + `lineOfBusiness`, normalised |
| `Loss` | `dateOfLoss` + `lineOfBusiness` + `amountOfLoss` |
| `Blanket` | `blanketNumber` |

**2. Match before create.** On apply, each candidate row is classified against
the account's existing rows and rendered with its verdict:

- **New** — no match. Creates. Selected by default.
- **Matches existing** — same key. Shows a field-level diff of what would
  change and **updates in place**. Selected by default; unselecting skips it.
- **Identical** — same key, no field differs. Skipped, shown greyed, cannot be
  selected. This is the case that produces today's duplicates.

**3. Idempotent re-apply.** Store `aiExtractionAppliedAt` on the Account when an
extraction result is applied. Applying the same `extractedAt` result twice with
no intervening re-run is a no-op with an explicit message, not a silent second
write.

**4. Never blind-create from a Lambda.** `lead-intake` creating a primary
Contact (W1) uses the same match-then-create path — a web form submitted twice
must not produce two contacts.

### Tests

`ExtractionPanel` is not currently covered. Add tests following
`MarketingTasks.test.tsx` (the template PATTERNS names, since these screens
cannot be driven in a browser behind magic-link auth):

- Apply the same extraction result twice → row counts unchanged.
- A building whose sq ft changed between runs → updated, not duplicated.
- A genuinely new building alongside two existing ones → exactly one create.
- A create failure still reports partial success (existing behaviour at
  `ExtractionPanel.tsx:250-266` — keep it).

---

## Migration and rollout

### Ordering — this is the part that loses data if rushed

1. **Add** the new models and columns. Deploy. Nothing is removed yet.
2. **Run the backfill** against staging. Dry-run mode first, printing what it
   would write. Review the per-account summary — especially W5's, which
   fans an account-level value out to every building.
3. **Verify**: for every account, the new rows reproduce the old column values.
   A verification query is part of the script, not an afterthought.
4. **Ship the UI** reading the new models. Old columns are now unread but
   still present — this is the rollback point.
5. **Only then remove** the old columns from `resource.ts`.

Removing a field from an Amplify Gen 2 model does **not** delete the attribute
from the DynamoDB items; it stops being selected. So step 5 is reversible by
re-adding the field, as long as steps 1–4 did not overwrite anything. Nothing
in this plan writes to a column it is about to drop — keep it that way.

### Script

`crm/scripts/backfill-lead-expansion.ts`, run with `tsx` against a deployed
backend (`amplify_outputs.json` + an ADMIN session). Requirements:

- `--dry-run` default; `--apply` to write.
- Idempotent via `extractionSourceKey = "backfill:<model>"` — running it twice
  writes nothing the second time. Prove this, don't assume it.
- Pages with `listAllPages`.
- Prints a per-account before/after table and a final tally.
- Run against **staging first**, then `main`.

### Branch strategy

Each workstream is its own commit on `staging`, verified on the staging Amplify
URL, then merged to `main` per the repo's stated workflow. W0 through W6 change
the schema, so each one is a backend deploy — do not batch them into one
mega-deploy where a failure is unattributable.

---

## Verification

Per PATTERNS, the CRM sits behind Cognito magic-link auth, so these screens
cannot be driven in a browser without a real sign-in. That makes the following
the actual gate, in order:

1. `npm run typecheck` — covers `crm/src` **and** `crm/amplify`. The enum
   guards in `enums.ts` mean a new schema enum without a label table fails
   here, which is the point.
2. `npm run test:run` — vitest. New tests required for: the W0.1 input
   formatters (phone edge cases: extensions, international, 7-digit),
   `useChildRows`' four states, the W8 placeholder regex, and W9's idempotency.
3. `enums.test.ts` additions for each new enum — and **prove the guard has
   teeth by mutation**: add a member, remove one, change a label, confirm the
   build actually fails each time. PATTERNS records a drift check that
   silently degraded to a vacuous pass; do not add another.
4. Deploy to staging, then exercise by hand: create a lead, add two contacts,
   two prior carriers, three buildings, two losses; generate a 125 and a 140;
   confirm the Activity tab shows every one of those writes with the right
   actor; re-run extraction and apply twice, confirming no duplicates.
5. For W7 specifically, confirm the negative control: a **STAFF** user's writes
   are attributed to them, and the Activity table cannot be written to from the
   client (`client.models.Activity.create(...)` must fail).

---

## Open questions

Answer these before the workstream that depends on them; none blocks W0.

1. **W1 — `ContactType`.** Is `OTHER` wanted beyond the seven named types? Are
   multiple contacts of the same type allowed (two trustees)? This spec assumes
   yes to both.
2. **W1 — primary contact.** Confirm that the ACORD insured phone/email should
   come from an explicitly-flagged primary contact rather than, say, always the
   manager.
3. **W4.4 — `limitAppliesPer`.** Reusing `AggregateAppliesTo` means the
   dropdown also offers Project and Other, which the requirement did not name.
   Acceptable, or should the GL section be restricted to Location/Policy?
4. **W4.5 — D&O parts.** Confirm what A / B / C mean here (Side A/B/C?) so the
   UI can label them properly instead of rendering bare letters.
5. **W5 — valuation labels.** Does "Extended Value Replacement Cost" mean the
   same as the existing `ERC` label "Extended Replacement Cost"? If not, the
   label changes and the ACORD 140 mapping needs re-checking.
6. **W5 — ACORD 140 per building.** One PDF per building, or fill multiple
   building sections per PDF? Depends on the real template — answer by
   inspecting one, not by assumption.
7. **W6 — loss extraction.** Should uploading a loss run auto-populate the
   Losses tab (subject to W9's review flow), or is that always manual entry?
8. **W7 — retention.** How long do Activity rows live? An account edited daily
   for five years is a lot of rows. A TTL attribute is nearly free to add now
   and awkward to add later.
9. **W7 — scope.** Should carrier, licensing and team changes get their own
   activity trail, or is account-scoped enough? This spec assumes
   account-scoped.
10. **W8 — unmapped forms.** Should a form with no deterministic mapping (810,
    823, 131…) become generatable on AI gap-filling alone? This spec says no by
    default.
