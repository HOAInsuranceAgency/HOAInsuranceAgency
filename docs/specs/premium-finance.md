# SPEC — In-house premium financing

Status: approved for implementation (W0–W1 firm; W2–W6 approved subject to the
decisions below).
Target: `crm/` — a `premium_finance` module, feature-flagged off by default.
Written against `staging` @ f3ba3df.

## What this is

HOA Insurance Agency LLC lends to its own clients so they can pay association
master-policy premium in installments. No separate entity, no premium finance
licenses — lawful only under narrow, conditional state exemptions. **The
software is the control that keeps the agency inside them.** Every rule below
is a hard constraint. Where a rule and a UX convenience conflict, the rule wins.

## Ground rules

- The jurisdiction table and the coverage-line lists are **signed-off data**,
  not code: `crm/config/premium_finance/jurisdictions.yml`. A generator emits
  the importable module; a drift test asserts equality; the generated module
  carries a SHA-256 of the YAML source, displayed on the admin screen so
  production can be checked against the signed file at a glance. The YAML is
  never edited to make a test pass — a conflict stops work and goes back to
  Jake.
- Eligibility keys off the association's **physical address state**
  (`Account.state`) — never the agency's state, never a mailing address. The
  account model has no mailing address today; if one is ever added, the gate
  must not move to it. A source-assertion test enforces that the gate reads
  nothing but the state.
- **The gate applies at origination only.** A jurisdiction closing must stop
  new originations and must not touch servicing of existing loans — we cannot
  un-lend. No eligibility check may sit in payment-posting, notice, or payoff
  paths; a test closes a jurisdiction and asserts an active loan still services.
- Fail closed, everywhere: unknown state → closed; unrecognized coverage line →
  blocked; producer-of-record unknown → blocked; `max_apr_verified: false` →
  closed regardless of status.
- All schema changes are additive nullable fields and new models — the stack's
  reversible-migration equivalent (precedent: Account's deprecated columns).
- Immutable records (`PfComplianceLog`, `PfNotice`) follow the Activity
  pattern: client authorization is read-only, writes happen in Lambdas over
  IAM, timestamps are server-set. No UI path can edit, skip, or back-date.
- No commit trailer crediting an AI tool on this module's commits.

## Decisions made (2026-08-21)

1. **YAML loading** — js-yaml as a devDependency; generated, checked-in TS
   module is what runs; drift test guards; generator embeds the YAML's SHA-256.
2. **Feature flag** — `AgencySettings.premiumFinanceEnabled`, ADMIN-writable
   via a dedicated mutation only, so counsel can stop originations in minutes
   without a deploy. **Every flip writes a `PfComplianceLog` row** (who, when,
   on/off). The toggle does not write through the ordinary settings path.
3. **Coverage lines** — allow/deny lists live in the signed YAML. Matching is
   on normalized tokens; unmatched blocks and shows the unrecognized value.
   Any deny-list match is the hard block, with the retroactive-void warning.
   **Flood is on neither list**: it is allowed only when
   `Account.type === "ASSOCIATION"` (the named-insured condition is structural
   today — policies hang off the account and the account is the association;
   revisit if a per-policy named-insured field ever appears). Anything unclear
   blocks for a human. Dedicated tests.
4. **Producer of record** — `Policy.producerOfRecord` nullable boolean.
   Bind-flow policies may pre-check the confirmation, with a label that states
   the consequence in plain words, stamped with user + timestamp on submit.
   Any other creation path (import, bulk, hand-entry) defaults null → blocked.
   Existing policies are null → blocked until confirmed.
5. **Money movement** — a second Stripe account with its own keys, settling to
   a separate operating bank account that is not the premium trust. Loan
   servicing does not ride invoices; the invoice `INTEREST` line kind stays
   unused by this module. **A financed transaction is four distinct movements
   that must never be netted**, and no single "financed premium" money object
   may exist in the schema:
   | Component | Source | Path | Character |
   |---|---|---|---|
   | Down payment | Association | → premium trust → carrier | Fiduciary premium |
   | Amount financed | Lending account | → carrier | Our capital |
   | Installments | Association | → lending account | Loan repayment, not premium |
   | Unearned premium on cancellation | Carrier | → lending account | Collateral recovery |
6. **Certificates of mailing** — manual entry: date + USPS certificate number
   + optional scan, entered by the mailer; the notice sequence cannot advance
   without one. Electronic mailing services are phase-two.
7. **Ohio `min_principal`** — measured against **amount financed**. Implemented
   generically; nothing Ohio-specific beyond the data row.

Additional rules from review:

- **(C) Board resolutions go stale** — issuance is blocked if the resolution
  on file has an execution date earlier than the effective date of the policy
  term being financed.
- **(D) Counsel opinions expire** — `PfCounselOpinion` carries a review date
  (default 24 months after effective). Past it, the jurisdiction reverts to
  blocked: "opinion past review."
- **(E) `max_apr` is a ceiling, not a target** — nothing defaults an APR to
  the cap and the UI never displays the cap as a suggestion. Default is 14.0%
  everywhere; the cap appears only in a rejection message.

## Quote-math conventions (pinned)

Simple interest, declining balance, monthly compounding. Level payment
`pmt = P·r / (1 − (1+r)^−n)`, r = APR/12. Schedule rounds to cents with the
final payment adjusted to clear the balance. Verified vectors: $1,000,000
premium, 25% down, 9 months — at 14.0% payment $88,269.61, total interest
$44,426; at 18.0% total interest $57,366. **Average outstanding balance
$317,332 is the mean of the twelve monthly OPENING balances across a 12-month
policy year, months 10–12 at zero.** That definition is load-bearing; closing
balances or a 9-month window do not reproduce the figure. $10.00 flat
origination fee, refundable on prepayment. Prepayment refunds by the actuarial
method. No late, delinquency, or reinstatement fields exist anywhere; the
Rule of 78s appears nowhere in the module, and tests assert both.

## Workstreams

- **W0** — spec; flag + `PfComplianceLog` + `setPremiumFinanceEnabled`
  mutation; dark nav/route/tab shell.
- **W1** — signed YAML; generator + SHA; jurisdiction gate; coverage
  classification incl. flood; admin table with unverified-row warnings.
- **W2** — quote engine (pure, shared by UI and Lambda) + calculator UI;
  then the server-side issuance mutation that re-validates APR cap /
  min-principal / eligibility and logs every decision.
- **W3** — eligibility screens on the policy: commercial-lines, producer of
  record, MEP vs down, auditable; ADMIN overrides with written reasons;
  extraction suggestions for MEP/auditable through the existing confirm flow.
- **W4** — agreement PDF (POA, verbatim ownership disclosure, TILA-style
  commercial APR block, actuarial prepayment terms) + board resolution
  template with the staleness rule; stored as Documents.
- **W5** — loan servicing: PfLoan/PfLoanPayment/PfNotice; payment posting;
  default detection cron; 15-day notice sequence with certificate-of-mailing
  gates; unearned-premium receivable at +30 days. Origination-gate-free by
  test.
- **W6** — counsel opinion store with review dates; lending-account tagging;
  the no-producer-compensation schema guard (tested by grep); admin surface.
