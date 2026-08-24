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
  term being financed. And "on file" is positive (2026-08-23): activation
  accepts only a Document on the loan's account filed under the uploadable
  category `PF_RESOLUTION_EXECUTED` ("Executed board resolution") — not the
  generated unsigned draft, not any other same-account paper — and every
  board-resolution compliance row records the attested document id.
- **(D) Counsel opinions expire** — `PfCounselOpinion` carries a review date
  (default 24 months after effective). Past it, the jurisdiction reverts to
  blocked: "opinion past review."
- **(E) `max_apr` is a ceiling, not a target** — nothing defaults an APR to
  the cap and the UI never displays the cap as a suggestion. Default is 14.0%
  everywhere; the cap appears only in a rejection message.

## Payment terms (2026-08-23)

25% of the premium is required up front, presented everywhere as **payment 1
of 12**: due at inception, no finance charge, and it takes the amount owed
from the premium down to the amount financed. The remainder finances over the
**11 remaining months** of the policy year as payments 2 through 12. In code:
`PF_MIN_DOWN_PCT = 25` (a floor — `downPctViolation` blocks below it, in the
panel and again at origination as logged rule `min-down`), `PF_DEFAULT_DOWN_PCT
= 25`, `PF_DEFAULT_MONTHS = 11`. A larger down payment or shorter schedule is
allowed; a smaller down payment is not.

**One payment path at a time.** Pay-in-full (a Stripe invoice link) and
financing are mutually exclusive per policy, enforced in both directions:

- Invoices keep working exactly as before while a loan is merely QUOTED — a
  quote is an offer, not a choice.
- **Full payment wins retroactively**: the Stripe webhook, on marking an
  invoice PAID, cancels any QUOTED loan on that invoice's policy
  (conditional QUOTED→CANCELLED, logged as `superseded-by-payment` with the
  ruleset SHA). ACTIVE loans are never auto-cancelled — money already moved;
  that is a human's problem, surfaced loudly.
- **Activation refuses proactively**: `ACTIVATE` blocks while any invoice on
  the policy is PROCESSING (a payment already clearing — they chose
  pay-in-full; cancel the quote) or SENT with a live Stripe link (void the
  invoice first, which kills its link through the path that already knows
  how). Logged as `exclusive-payment-path`.

So payment links are still minted at invoice send, financing quotes are
issued freely alongside them, and the exclusion bites at the two moments
money actually commits: a link getting paid, or a loan activating.

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
- **W7** — customer election + autopay (below; approved for spec 2026-08-23,
  implementation awaiting sign-off of this section).

## W7 — Customer election and autopay (decisions 2026-08-23)

Jake's direction, recorded after the end-to-end staging run: the association
should choose its payment path from the invoice email itself, and a financed
deal should collect itself monthly — the only manual act left in the money
path is the customer's own click.

### Decision 5, revised: one rail, split on the ledger

**Supersedes the 2026-08-21 money-movement decision.** All money moves on the
existing Stripe account and settles to the premium trust — down payments,
installments, everything. There is no second Stripe account and no separate
lending bank account. The four movements remain distinct as *ledger* facts,
never as bank accounts: every receipt emails its breakdown (premium vs. loan
repayment; principal vs. interest per the frozen schedule) to
`ACCOUNTING_MAILBOX` (production: `corporateaccounting@getgim.com`), and
corporate accounting divides the trust. `PfLoanPayment` keeps its
principal/interest split — the no-netting principle survives at the record
level, which is the level an examiner reads.

The commingling concern that motivated segregation was surfaced again and
this is recorded as Jake's decision (2026-08-23); counsel can revisit.
Consequences in code: the `POST_PAYMENT` designated-lending-account guard and
its message ("loan money must not touch the premium trust") are removed; the
admin "Lending account" card becomes an accounting label only, or goes.

### The election

- Staff flow is unchanged up to the email: issue a finance quote (all W2/W3
  gates run then, as today), then send the invoice. **The customer never
  originates** — the email offers financing only when the policy carries a
  QUOTED loan at send time; otherwise the email is pay-in-full only, exactly
  as today.
- The email presents two actions: **Pay in full** (the existing single-use
  Stripe link) and **Finance — 25% down, then 11 monthly payments** (a
  signed URL to a public election page, HMAC pattern shared with
  magic-link/upload-portal, expiring with the quote).
- The election page shows the frozen schedule (payment 1 of 12 = the down
  payment, payments 2–12 monthly, APR, finance charge, the $10 fee, the
  actuarial prepayment terms — the same TILA-style block the agreement
  carries), collects the 25% down payment immediately, and completes a Stripe
  ACH debit mandate (SetupIntent, `us_bank_account`) for the remainder. The
  page checks the kill switch and fails closed.
- Election is a choice, so it excludes in both directions at once: it voids
  the pay-in-full invoice through the existing void path (link dies, number
  retired, logged `exclusive-payment-path`), and a paid invoice already
  cancels QUOTED loans — a link that got paid first wins, an election that
  happened first kills the link.

### ACCEPTED, between QUOTED and ACTIVE

A new loan status. QUOTED means an offer; ACCEPTED means the association
chose it: down payment received (recorded on the loan as payment 1 of 12,
with its PaymentIntent id), mandate on file. Money has moved, so the webhook
must never auto-cancel an ACCEPTED loan (same rule as ACTIVE: a human's
problem, surfaced loudly). Activation keeps every existing gate — executed
board resolution by name, staleness, exclusive-payment-path — and remains a
staff act. ACCEPTED → ACTIVE is when debits begin: **mandate now, debits on
activation** (decision, 2026-08-23).

### Autopay servicing

- A daily cron (beside `pf-default-sweep`) creates an off-session
  PaymentIntent for each ACTIVE loan with a mandate whose `nextDueAt` has
  arrived, for the exact cents of the frozen schedule row. One attempt per
  due installment per day; every attempt logged.
- The Stripe webhook, on `succeeded`, posts the `PfLoanPayment` exactly as
  the manual path does today (split, balance, `paidThrough`, `nextDueAt`,
  cure-on-posting), actor `stripe-autopay`, and emails the split to
  accounting. Manual `POST_PAYMENT` survives for out-of-band money — a check
  still arrives sometimes.
- A failed debit posts nothing; the default sweep flips DEFAULTED exactly as
  today, and DEFAULTED **pauses further attempts** — the 15-day notice
  sequence governs from there. A cure (manual posting or a retried debit
  after reinstatement) resumes the schedule.
- PAID, CANCELLED, and prepayment (actuarial payoff) end debit creation;
  disabling the module stops elections and new originations but never stops
  debits on ACTIVE loans — the gate still never touches servicing.

## W8 — Origination disappears into invoicing (signed by Jake, 2026-08-24)

The quote form is gone. Financing is not a thing staff configure per deal;
it is a standing product with fixed terms that offers itself wherever the
gates allow:

- **Fixed terms, nowhere editable**: 25% down (payment 1 of 12), 14% APR,
  11 monthly installments. The financed amount is **the invoiced total** —
  what the association actually owes, retail lines included — not the
  carrier premium. The auto-quote's schedule anchors at the invoice send
  date: the deal starts when the customer can accept it, so a policy
  invoiced late in its term does not begin life in arrears.
- **Origination happens at invoice send**, through the same shared core
  the mutation used, with every gate intact: kill switch (transactional),
  jurisdiction, APR cap (effective-rate where the row says so),
  min-principal, coverage, producer-of-record, auditable, incorporated.
  A block means a pay-in-full-only email — and the invoice screen says
  which screen blocked and why. Re-pricing a re-sent invoice supersedes
  the stale quote (`superseded-by-repricing`, logged) and issues fresh at
  the new total. An ACCEPTED or ACTIVE loan on the policy suppresses any
  new origination — the choice was made.
- **The MEP screen is REMOVED** (signed 2026-08-24). The agency lends its
  own capital and knowingly accepts early-default undersecurity on
  high-MEP policies — the worst case being roughly the accrued interest on
  a deal whose carrier refund exactly covers principal. MEP stays recorded
  on policies as underwriting data; it no longer gates the offer, and the
  MEP override with it.
- **The AUDITABLE screen is REMOVED too** (signed by Jake, 2026-08-24:
  "everything we do is final once entered" — this book's premiums do not
  move at audit). The isAuditable fields become dead columns kept for
  existing rows; nothing asks the question, carries it at bind, extracts
  it, or gates on it. With it went the last override: PfOverride is a
  read-only historical record now, and no surviving screen (coverage,
  producer-of-record, RI's incorporated) has or may grow a waiver — each
  blocks on a fact only confirming can fix.
- **Every invoice bills exactly one quote or policy**, chosen at creation,
  and an anchor carries **one live invoice at a time**
  (DRAFT/SENT/PROCESSING); PAID and VOID free the slot for endorsement and
  audit billing. Enforced at creation in the UI and again at send in the
  Lambda.
- **Invoicing a quote is first-class** (signed 2026-08-24): premium is
  billed — and financing offered — before bind, and **binding rolls the
  invoice and any live loan to the new policy** as part of the bind flow.
  The loan gains a nullable `quoteId`; `policyId` loosens to optional and
  is set at rollover (a `BIND_ROLLOVER` servicing action, since clients
  cannot write loans); every exclusion scan matches the invoice's anchor,
  quote or policy. Terminal loans do not roll.
- **The agreement is signed before money moves** (signed 2026-08-24).
  The election page renders the agreement's terms — POA, ownership
  disclosure, the TILA-style APR block, actuarial prepayment terms — and
  the accepting person (PM, PM's finance team, or a board member: whoever
  is electing) signs by typed name with their role. The signature — name,
  role, instant, IP — rides the election transaction itself, so no
  Checkout session can exist for an unsigned agreement; the generated
  agreement PDF renders the signature block from the loan's record. This
  is the E-SIGN/UETA click-wrap form, distinct from — and in addition to —
  the board resolution the activation gate still demands.
- **The Financing tab is servicing only**: the loans table, activation,
  notices, cancellation. Origination has no UI anywhere.

### W8 hardening (adversarial review, 2026-08-24)

Decisions the review forced, now part of the design:

- **A committed election is untouchable.** Committed means money is in
  flight or could be within minutes: a stamped down-payment intent, or a
  live Checkout session/claim. Supersession — re-pricing at send, a paid
  invoice's cancel sweep — carries `attribute_not_exists(downPaymentIntentId)`
  (and, at send, the live-session check) in its write condition, and the
  read-time paths refuse first. A bill re-priced over a committed election
  offers nothing and says so in the logs: that knot is a human's.
- **The election transaction refuses under a clearing down payment** —
  both the stamp and the session claim carry the intent guard, because
  Stripe can sit on a settlement event for hours and the read-time
  "already clearing" check races it.
- **The one-live-per-anchor send check sees everything**: header ids,
  line-level policy ids (pre-W8 invoices anchor only through lines), and
  the policy's own `quoteId` (a pre-bind invoice whose rollover failed
  still holds the policy's slot). A quote-anchored invoice refuses to send
  once its quote closes.
- **Bind refuses a second policy from one quote** (the hasOne is a query
  convenience, not a constraint), checks its writes' GraphQL errors, and
  rolls each invoice and loan independently; the Financing tab carries a
  rollover retry for a loan stranded on a bound quote.
- **Activation requires a policy.** An elected quote-anchored loan holds
  its down payment and mandate, but debits begin only after bind rolls it
  — collateral is unearned premium, and that exists only once coverage is
  placed.
- **The origination mutation enforces the fixed terms too** — the API is
  not a back door around "not able to be edited".
- **The compliance log never fabricates**: a loan-create transaction
  cancelled by conflict or throttle (not by the flag condition) writes no
  kill-switch story, and the election's PASS row names the signer read
  back off the loan after commit, not the caller's own inputs.
- **The signature IP is evidence, not proof**: first X-Forwarded-For hop,
  shape-checked and bounded before it can reach the loan, the log, or the
  printed agreement. The signature's substance is the typed name and role.
- **The staleness rule's boundary is the loan's quote date** (re-drawn
  2026-08-24 after the staging E2E). The original form — refuse a
  resolution executed before the financed term began — blocked every
  advance-bound deal: boards authorize the agreement in front of them
  before coverage begins, which is how binding works. What the rule
  protects against is last term's paper, and paper that predates this
  loan cannot be authorizing it — so activation refuses a resolution
  executed before the loan was quoted, or dated in the future, and
  accepts anything from quote day onward.
- **The Invoices and Financing tabs show for leads** (same E2E). Billing
  a quote before bind is the new-business flow, and new business is a
  lead; hiding the money tabs behind CLIENT stage hid the feature from
  its audience. Only the Policies tab still waits for a bind.

### Rhode Island opened (signed by Jake, 2026-08-24)

RI's row left the unverified-ceiling state on Jake's verification, and it
brought two new signed-data fields with statute-specific enforcement:

- `max_apr: 21.0, max_apr_verified: true` — § 6-26-2's ceiling is the
  greater of 21% or prime+9; 21% governs.
- **`fee_counts_toward_cap`** — the service charge counts toward the
  ceiling, so the APR-cap check tests the EFFECTIVE rate: the actuarial
  rate that discounts the frozen schedule back to the amount financed net
  of the $10 fee (`effectiveAprWithFee`, solved on the schedule itself,
  held-to-term, prepayment refund not assumed). On small principals this
  bites where the nominal rate slips under — the case the flag exists for.
- **`requires_incorporated_borrower`** — § 19-14.1-10(b)(1) lends to
  incorporated associations only. Enforced as a fifth eligibility screen,
  producer-of-record style: `Account.incorporated` (new additive nullable
  field, recorded on the Property card from the association's articles)
  must be explicitly true; unrecorded blocks; no override exists. The
  screen renders only where a row demands it.
- Both fields are refused on closed rows by the generator — borrower-form
  and fee rules on a row that cannot lend assert checks nobody made.
- ch. 19-14.6's form and cancellation rules are the notice sequence the
  module already runs; the note records the citation.

### W7 hardening from external review (2026-08-24)

Nine Greptile rounds on PR #14 drove these invariants, now enforced and
source-asserted by tests:

- **Every money-adjacent write transacts with what it depends on.** The
  election stamp and the session claim each carry a ConditionCheck on the
  kill switch; the ledger row and the loan advance are one transaction;
  cancellation pins the exact `defaultedAt` episode its 15-day verdict
  validated, and names that episode's intent on the request row.
- **One payable session per premium.** The claim transaction also
  ConditionChecks every quoted sibling's slot (commit-time serialization),
  a funded election cancels sibling quotes (`superseded-by-election`),
  and a disable landing between claim and mint finds the session expired
  before its URL is handed out.
- **A refused election costs the customer nothing.** Pay-in-full links
  are voided only after the guarded stamp commits; every refusal before
  that leaves the invoice payable.
- **The audit trail can neither miss nor invent a flip.** A disable whose
  response is lost verifies strongly and logs only when its own stamp
  made the state; an off it did not cause is reported as such, with no
  row; a failed enable's correction retries against the moved stamp and,
  failing everything, annotates its own ENABLED row void.
- **Autopay converges.** Stale claims self-heal by asking Stripe what
  exists; one failed debit stands the installment down for the sweep;
  the sweep's stand-down holds at write time via the mark's condition.

### W7 decisions recorded after adversarial review (2026-08-23)

- **One failed debit stands autopay down for that installment** — no daily
  retry loop (re-presentment limits, and the sweep must actually get to
  flip DEFAULTED). A posting of any kind is the cure that resumes the
  schedule. A stale claim (a debit attempt whose outcome was lost) heals
  itself: the next run asks Stripe what exists and adopts, stands down, or
  retries; ten days unresolved alarms accounting and the compliance log.
- **The election link is a stored random token** (the upload-portal
  pattern), not the HMAC scheme the first draft named — the row is the
  validity and there is nothing to forge. TTL is a fixed 60 days; the real
  expiry is the loan leaving QUOTED.
- **The mandate rides Checkout** (payment mode, `setup_future_usage:
  off_session`), not a separate SetupIntent — one hosted page collects
  payment 1 and the authorization together.
- **One live offer per policy, enforced at accept**: financing money has
  touched refuses outright; an older QUOTED sibling loses to a newer one.
  Accept also refuses while its own down payment is clearing — the
  loan-side mirror of the invoice PROCESSING rule.
- **The election voids only links billing the financed premium** (matched
  by the link's minted cents); any other open-linked invoice on the policy
  refuses the election for a human to resolve. Each void is logged under
  `exclusive-payment-path`.
- **Activation checks the kill switch** — it is the last origination act,
  not servicing — and refuses when any invoice on the policy is PAID.
- **A paid invoice beside an ACCEPTED/ACTIVE/DEFAULTED loan alarms**
  (accounting email + `exclusive-payment-path` BLOCK row); nothing is
  auto-cancelled once money moved.
- **W8, deliberately deferred**: a staff CANCEL/refund action for ACCEPTED
  loans whose paper never comes (today they unwind only forward, by
  activation — the operational unwind is a Stripe-dashboard refund plus a
  hand reconciliation); and a decision on late activation, where the frozen
  schedule makes past-due installments catch up at one debit per day rather
  than re-anchoring the dates.
