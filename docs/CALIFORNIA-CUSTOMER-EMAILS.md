# California customer email identity

Automated customer correspondence follows the insured property's Account state. CA and California (trimmed and case-insensitive) use Condo Insurance Agency. Other states and unknown states retain the existing HOA Insurance Agency branding.

All California customer messages include:
"HOA Insurance Agency LLC does business in California as Condo Insurance Agency."

## Wordmark decision

Use a plain text Condo Insurance Agency wordmark until the logo design is finalized. The temporary transparent-logo sample is not part of this release. No California logo image is hosted, embedded, or used by the production templates.

## Customer flows

- Initial lead reply, including the optional document-upload request.
- Invoice email, including standalone and combined financing options.
- Invoice PDF attachments, with the disclosure on every page.

Lead replies retain their assigned producer's verified personal mailbox, author, and text contact/license details from Front. For California, the prepared body includes that signature as branded text and suppresses a second native Front signature. The signature must retain a text email address, phone, and license number; details stored only in images hold the reply for correction. Signature lookups and validation run before generation is claimed, so temporary failures remain retryable. Link destinations are retained even when their labels say Email me or Call me.

Invoice sender addresses, payment calculations, financing restrictions, and the legal check payee are preserved. Non-California mail retains its current names, logos, and Front signatures.

Staff invitations, staff sign-in links, internal reports, accounting alerts, upload comments, human-reviewed Front business drafts, and regulated forms are outside this automated customer-email change.

The shared identity rule is in `shared/customerEmailIdentity.ts`. The regression tests cover California/other/unknown states, customer prose, preserved personal signatures, sender identity, complete-message delivery matching, invoice variants, and PDF disclosures.
