# Policy broker fees

Broker fees are optional agency revenue on an individual quote and policy term. New quotes, including renewals, start at $0. They are separate from carrier premium, carrier commission, taxes, carrier/wholesaler charges, and financing charges.

## Existing workflow

1. Record the optional dollar fee beside premium and commission in the quote form. Positive fees use cents precision. On fee-bearing quotes, choose the existing bill type before presenting terms so a direct-bill placement collects only the agency fee. This answer is carried into bind. The normal quote/proposal shows premium, the fee, and premium plus fee; package proposals sum the distinct policies without duplicating their fees.
2. Include the fee agreement in the existing client quote/proposal delivery. One agreement can list the proposed policies and each fee, with one customer signing event. State-specific disclosures or other required content can add pages; a strict one-page maximum is not a nationwide compliance rule.
3. The customer signs and submits payment through the existing delivery/payment experience. The bind panel displays fee signature and collection status. Binding still uses the existing action, with server checks for current signed terms and submitted/clearing or completed payment.
4. Binding preserves the fee, signed agreement, producer attribution and applicable producer rate. Fee changes are part of quote authorization and package review fingerprints; a changed fee requires current client agreement. Fee-free legacy fingerprints remain unchanged.
5. The signed document stays on the account and appears under every covered quote/policy filter. Multiple quote/policy links point to one document rather than duplicating the signed file.

The policy form shows the bound fee read-only. Editing an ordinary policy must not alter an already agreed financial obligation or its frozen producer compensation.

## Money and compensation

- Carrier commission remains `premium × carrier commission percentage`.
- Producer fee earnings use the normal applicable producer share frozen on the bound policy. For example, a $500 broker fee at a 40% producer share earns $200 for the producer and retains $300 for the agency. The carrier commission percentage is not applied to the broker fee.
- Actual successful fee receipts and actual refund/dispute reductions are recorded separately. Payment submission/processing is enough for the configured bind prerequisite; submission is not collected cash or a producer payout.
- Fees are earned at bind and retained after cancellation except refunds required by applicable law. If coverage is not bound, the agreement provides for refund. A fee refund reduces the corresponding fee earnings; it does not silently prorate with premium or recreate a receivable.
- `Policy.brokerFeeCollected` is lifetime gross successful receipts. `brokerFeeRefunded` is lifetime actual reductions. Net collected is collected minus refunded; the balance awaiting collection is `max(0, brokerFee − gross collected)`. A refunded amount is not automatically charged again.
- Fee balances are components of policy billing. Do not add the broker-fee balance to invoice A/R again.

## Reporting basis and privacy

The Performance dashboard adds booked broker fees, actual fee refunds, net fee revenue and total agency revenue per person. Its existing basis remains policy effective date and the account's **current salesperson**. Cancelled premium/carrier commission follows the existing inclusion control; retained fees remain included and only actual fee refunds reduce them. Total agency revenue is estimated carrier commission plus booked fees minus recorded fee refunds, before producer compensation.

Finance shows all-time bound fee aggregates from confirmed receipts/refunds and balances awaiting collection, including cancelled policies with retained fees. Its per-person view uses current account assignment and labels that basis. It is not a receipt-date income statement.

Owner profitability adds fee revenue to its existing effective-date/current-assignment estimate. Its private dated compensation share applies to both estimated revenue sources. This remains an estimate using private pay settings, not actual new/renewal payroll. Actual producer earnings, original producer attribution, receipts, adjustments and payouts stay in the private Commissions workflow; public policy/dashboard rows do not expose private compensation rates or individual pay.

## Jurisdiction requirements

Support for all policy classes and states does not imply permission to charge a fee on every placement. Eligibility and required disclosure content depend on the insured risk/jurisdiction, personal versus commercial coverage, admitted versus surplus-lines placement, producer capacity/appointments, carrier contracts and applicable fee limits. Do not infer eligibility from an agency's nationwide licenses alone, or label a generic template compliant in all states.

Known requirements informing the design:

- Massachusetts DOI Bulletin 2013-09 requires disclosure of the amount and purpose in writing before sale, exclusion from carrier premium, and separate itemization in cost documentation. The bulletin itself does not impose a client signature or one-page form: [MA DOI bulletin](https://www.mass.gov/doc/bulletin-2013-09-fees-charged-by-insurance-producers-relative-to-the-sale-of-insurance-in-the-commonwealth-issued-10413/download).
- California's Article 6.8 rules apply to the specified personal insurance. They require acting as broker rather than appointed placement-insurer agent, an in-force filed broker bond, initial-quote notice, the standard disclosure and an agreement containing all standard provisions, client and broker signatures, applicable language versions, and specified pamphlets. FAIR Plan/CAARP procurement fees are excluded. Some refunds remain mandatory despite nonrefundability language: [actual regulations](https://www.insurance.ca.gov/0250-insurers/0500-legal-info/0500-gen-legal-info/0100-brkr-fee-reg-summ/broker-fee-regulations-actual.cfm), [disclosure](https://www.insurance.ca.gov/01-consumers/130-laws-regs-hearings/05-CCR/brkrdiscl.cfm), [agreement](https://www.insurance.ca.gov/01-consumers/130-laws-regs-hearings/05-CCR/sbfa.cfm).
- Florida expressly permits reasonable separately itemized per-policy retail fees for surplus-lines placement. This is not blanket permission for ordinary admitted-policy retail fees. The filing surplus-lines agent's taxable fee and retail fee differ: [§626.916](https://www.flsenate.gov/Laws/Statutes/2025/626.916), [FSLSO guidance](https://www.fslso.com/faq-topics), [DFS general-lines guidance](https://www.myfloridacfo.com/division/agents/compliance/general-lines-agents-customer-reps).
- Washington requires policy-specific fee/compensation information and signatures. Its optional standard form instructs separate disclosure forms for each policy; combining policies into one document must preserve applicable requirements: [WA disclosure guidance](https://www.insurance.wa.gov/producers-adjusters/licensing-compliance-financial-examinations/compensation-and-disclosure/disclosure).
- New York's broker service-fee agreement requires the charged party's signature and clearly defined compensation. A premium-finance agreement alone does not replace that agreement: [NY DFS guidance](https://www.dfs.ny.gov/industry_guidance/circular_letters/cl2006_09).

These examples are not a completed 50-state legal survey. Production configuration and form content need the applicable rules for each enabled placement; unsupported or missing eligibility facts must not become an automatic positive fee authorization.

## Industry model

AMS360 documents agency fees as separate policy billing charges, including fees on otherwise direct-bill policies. Its production reporting distinguishes premium from non-premium and tracks producer compensation on both. This supports integrating the fee into current billing/compensation/reporting rather than creating a separate sales process: [billing workflow](https://help.vertafore.com/AMS360/content/howtos/accounting/htbillbenefitsagbillfees.htm), [production analysis](https://help.vertafore.com/AMS360/content/reports/csreportprodanalysis.htm).

The public website's former universal “no broker fee” promises are replaced with disclosure-before-purchase language. Free preliminary reviews/indications remain described separately from a disclosed placement fee.

## Setup and release

In **Settings → Agency → Broker fee disclosures**, configure each enabled jurisdiction's reviewed coverage/billing scope, fee limit, review source/version, and complete required state wording. No state permissions or legal forms are seeded. Missing configuration blocks only positive broker fees; fee-free legacy workflows and authorization fingerprints remain valid. Changing an existing rule requires a new review version; unchecking enablement stops new fee agreements for that state.

Enable policy-specific insurer commission disclosure where required. It displays the carrier/agency percentage and amount, never private producer compensation. Required agency countersignatures use a named, explicitly authorized agency signer with a server-recorded authorization identity/time; changing that identity requires fresh authorization.

Signed disclosures are immutable account documents linked to all covered quotes and policies. Their accounts retain a server-owned history marker so deleting a lead cannot destroy executed agreements. The client signs from the normal proposal email and receives the existing issued invoice/finance links after signing. An invoice may reuse its package's existing combined agreement; unchanged signed agreements reuse the original PDF rather than requesting another signature.

Payments are reconciled in integer cents using frozen charge allocations and the agency's New York receipt date. Successful pre-bind payments remain durable until binding supplies producer attribution. A five-minute recovery job completes interrupted allocations. A full verified refund or final lost charge dispute reverses the original fee allocation; partial mixed-premium refunds/disputes require an explicitly identified fee component, never guessed proration. Existing payroll adjustment review remains in place; this feature does not automatically deduct wages.

Once an invoice fee payment is issued, its quote terms and charge lines are protected. Use the existing void/reissue action to revise an unpaid offer; voiding closes open fee checkouts first. Submitted payments and live financing checkouts preserve their terms until resolved. The existing manual Mark paid action uses the same source validation and receipt allocation as processor payments.

Deploy first to the retained staging branch `codex-hoa-staging-migration` using its existing staging build-spec override. Preserve the retained namespace and stateful resources; do not deploy the retired source backend. Promote only the broker-fee commits to `main` after review and staging verification.
