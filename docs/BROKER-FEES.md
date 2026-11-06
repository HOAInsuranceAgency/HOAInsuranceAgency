# Policy broker fees

The deployment guard continues to verify the exact identities and hash of all 57 retained stateful resources. It separately permits one broker-fee ledger with a stable name derived from the retained backend root, and verifies that table's account, region, deletion protection, key and three indexes. Every other stateful addition or replacement remains blocked.

Broker fees are optional agency revenue on an individual quote and policy term. New quotes, including renewals, start at $0. They are separate from carrier premium, carrier commission, taxes, carrier/wholesaler charges, and financing charges.

## Existing workflow

1. Record the optional dollar fee beside premium and commission in the quote form. Positive fees use cents precision and require **agency billing**. Selecting a positive fee selects agency billing; the server also rejects fee-bearing direct-bill quotes, invoices, agreements and binding. This answer is carried into bind. Record carrier/wholesaler fees and taxes as separate pass-through charge rows in the same quote form. The proposal itemizes gross client premium, supplier charges, taxes, the HOA fee and the complete policy cost; package totals sum the distinct policies without duplicating their fees.
2. Include the fee agreement in the existing client quote/proposal delivery. One agreement can list the proposed policies and each fee, with one customer signing event. State-specific disclosures or other required content can add pages; a strict one-page maximum is not a nationwide compliance rule.
3. The customer signs and submits payment through the existing delivery/payment experience. The bind panel displays fee signature and collection status. Binding still uses the existing action, with server checks for current signed terms and submitted/clearing or completed payment.
4. Binding preserves the fee, signed agreement, producer attribution and applicable producer rate. Fee changes are part of quote authorization and package review fingerprints; a changed fee requires current client agreement. Fee-free legacy fingerprints remain unchanged.
5. The signed document stays on the account and appears under every covered quote/policy filter. Multiple quote/policy links point to one document rather than duplicating the signed file.

The policy form shows the bound fee read-only. Editing an ordinary policy must not alter an already agreed financial obligation or its frozen producer compensation.

## Agency-billed client packet

The quote's Premium field means the client's gross insurance premium before fees and taxes. New invoice premium lines use that gross amount as retail and leave supplier cost for the actual remittance amount. Do not derive that cost from a commission percentage. Sending or recording a manual receipt requires an explicitly recorded premium cost; existing saved invoice lines are not reinterpreted or backfilled.

Carrier fees, wholesaler fees, taxes, surplus-lines tax and stamping fees pass through at equal retail and cost. Stable source-charge IDs carry their exact labels and cents amounts from the quote through binding into the policy and generated invoice lines. The invoice cannot omit, duplicate, relabel or mark up a recorded source charge. Supplier charges do not contribute to HOA broker-fee revenue or producer fee earnings. Base premium and carrier commission reports retain their existing premium-only basis.

The first invoice created from a source locks the gross premium to that source. Once the original premium invoice is paid, choosing the policy again in the existing Create invoice action automatically creates an endorsement or audit adjustment. Its stored references to the paid original invoice and premium line are verified by the server. The original premium, supplier charge schedule and HOA fee are not charged again. Adjustment amounts and actual supplier costs remain editable, including signed credit deltas; supplier/tax rows pass through at cost. The inception premium-finance offer is not repeated for an adjustment.

Credit and zero-balance adjustment statements request no payment and cannot be recorded as incoming receipts. Once issued with a complete nonpayable balance snapshot and no online payment path, they allow later policy billing while remaining in the invoice history. Original paid invoices, their premium lines and one-time quote-to-policy provenance links are preserved.

Existing unflagged adjustment invoices keep their behavior. For older bound policies that have no recorded charge schedule, the existing invoice editor still accepts separately labeled supplier fees and taxes at equal retail/cost. This exception uses the actual stored policy provenance; new binds always carry an explicit schedule, including an empty one, and cannot clear it to claim legacy status.

The normal proposal includes optional reviewed client-facing conditions, separate from private quote notes. Preserve the actual carrier's binding subjectivities, cancellation/minimum-earned terms and required coverage notices in reviewed conditions and selected carrier attachments. A wholesale authorized-representative signature does not constitute client fee consent. Do not apply a source document's cancellation terms or scheduled-limits warning universally to other policies.

The HOA invoice controls the amount payable to HOA and its existing payment link. Source wholesale payment instructions concern agency remittance; the proposal and email tell clients to contact HOA before making a separate payment. Staff use the existing attachment preview to choose client-facing carrier quotations and required notices and check source documents for private agency compensation or conflicting payee instructions. The CRM does not silently redact or rewrite original carrier PDFs.

Without an HOA fee, the same itemized proposal and invoice apply and no HOA fee agreement is generated. With an HOA fee, the existing combined fee agreement and electronic signing link are included. Pre-bind invoices identify a proposed effective date and do not claim that coverage has been bound. A verified bound-policy record supplies bound wording.

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

HOA's product rule is stricter: a policy carrying an HOA broker fee must be agency billed.

The public website's former universal “no broker fee” promises are replaced with disclosure-before-purchase language. Free preliminary reviews/indications remain described separately from a disclosed placement fee.

## Setup and release

In **Settings → Agency → Broker fee disclosures**, configure each enabled jurisdiction's reviewed coverage/billing scope, fee limit, review source/version, and complete required state wording. No state permissions or legal forms are seeded. Missing configuration blocks only positive broker fees; fee-free legacy workflows and authorization fingerprints remain valid. Changing an existing rule requires a new review version; unchecking enablement stops new fee agreements for that state.

Enable policy-specific insurer commission disclosure where required. It displays the carrier/agency percentage and amount, never private producer compensation. Required agency countersignatures use a named, explicitly authorized agency signer with a server-recorded authorization identity/time; changing that identity requires fresh authorization.

Signed disclosures are immutable account documents linked to all covered quotes and policies. Their accounts retain a server-owned history marker so deleting a lead cannot destroy executed agreements. The client signs from the normal proposal email and receives the existing issued invoice/finance links after signing. An invoice may reuse its package's existing combined agreement; unchanged signed agreements reuse the original PDF rather than requesting another signature.

Payments are reconciled in integer cents using frozen charge allocations and the agency's New York receipt date. Successful pre-bind payments remain durable until binding supplies producer attribution. A five-minute recovery job completes interrupted allocations. A full verified refund or final lost charge dispute reverses the original fee allocation; partial mixed-premium refunds/disputes require an explicitly identified fee component, never guessed proration. Existing payroll adjustment review remains in place; this feature does not automatically deduct wages.

Once an invoice fee payment is issued, its quote terms and charge lines are protected. Use the existing void/reissue action to revise an unpaid offer; voiding closes open fee checkouts first. Submitted payments and live financing checkouts preserve their terms until resolved. The existing manual Mark paid action uses the same source validation and receipt allocation as processor payments.

Payment preparation reserves the fee through link creation and invoice delivery. Financing and manual receipts cannot bypass an unfinished send. Retry an interrupted send using the existing Send action; it resumes the same payment setup. If the processor link remains unknown after 20 hours, automatic creation stays blocked until the original processor payment setup is reviewed. Voiding releases the reservation together with the invoice status after known checkout sessions are closed.

Deploy first to the retained staging branch `codex-hoa-staging-migration`. The repository's `amplify.yml` drives monorepo builds; its deployment helper resolves the retained staging namespace from the existing environment contract. Pre- and post-deploy guards verify stateful resources. Preserve the retained namespace and do not deploy the retired source backend. Promote only the broker-fee commits to `main` after review and staging verification. Both hosted CRM branches use a 6 GiB Node heap within their existing 8 GiB build instance.
