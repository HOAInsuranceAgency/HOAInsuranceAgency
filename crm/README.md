# HOA CRM

Internal agency management system replacing EzLynx for the commercial
(association) book. Vite + React SPA on an AWS Amplify Gen 2 backend.

## Architecture

- **Auth** — passwordless magic-link sign-in ONLY (Cognito custom auth
  challenge, [amplify/functions/magic-link](amplify/functions/magic-link)):
  enter your email → SES sends a link signed with a Secrets Manager HMAC
  secret (15-min expiry) → clicking it signs you in. Sessions last 7 days.
  No self-signup: users are created by an admin (Cognito console/CLI).
  The sender address must be SES-verified (`MAGIC_LINK_FROM` in
  [amplify/backend.ts](amplify/backend.ts), currently `noreply@gim.llc`;
  branch URLs for the link live in `BRANCH_URLS` there too).
  Groups `ADMIN` / `STAFF` / `PRODUCER` exist as placeholders; privileges
  are not enforced yet. First login runs an onboarding flow
  ([src/pages/Onboarding.tsx](src/pages/Onboarding.tsx)); producers must
  supply an NPN and at least one state license.
- **Data** — AppSync + DynamoDB, schema in
  [amplify/data/resource.ts](amplify/data/resource.ts).
- **Documents** — S3 ([amplify/storage/resource.ts](amplify/storage/resource.ts)).
  Uploads land at `documents/{entityType}/{entityId}/{documentId}/{filename}`,
  which triggers the Textract Lambda
  ([amplify/functions/process-document](amplify/functions/process-document)) —
  it OCRs PDFs/images (text + tables) and writes results back onto the
  `Document` record. The UI shows live OCR status and searchable extracted text.

## Domain model

```
Account (stage: LEAD → CLIENT)
  ├─ Quote ──(bind)──▶ Policy          ← binding converts the lead in place
  ├─ Certificate (ACORD 25 history)
  └─ Document (polymorphic — attaches to any entity)
Carrier ── AppetiteGuide               ← "carrier appointments", drives Appetite Finder
UserProfile ── ProducerLicense
```

Rules encoded in the app:

- A Client can only be created by binding a quote on a Lead (there is no
  "create client" form). Conversion is in place, so all documents, quotes,
  and history carry over.
- Binding a quote creates the Policy from the quote's carrier/lines/premium/
  dates and stamps `convertedAt`.
- Documents can be attached to accounts, carriers, quotes, policies, etc.

## Local development

```sh
npm install
npx ampx sandbox     # personal cloud backend; writes amplify_outputs.json
npm run dev          # second terminal
```

`amplify_outputs.json` is generated (gitignored). The checked-in placeholder
only exists so `npm run build` typechecks before a sandbox has run.

## Deployment

Deployed as the `crm` app of the monorepo (see root [amplify.yml](../amplify.yml)).
`ampx pipeline-deploy` gives `main` and `staging` fully isolated backends
(separate user pools, tables, buckets).

## ACORD forms

Certificate issuance fills the ACORD 25 template client-side with pdf-lib
([src/lib/acord.ts](src/lib/acord.ts)) and stores the PDF under
`certificates/` in S3. Because ACORD PDFs are licensed, the fillable template
is uploaded by the agency via **Settings** (→ `templates/acord25.pdf`), not
shipped in the repo. Field names differ between form editions, so the mapping
uses candidate lists per logical field — use Settings → *Inspect fields* to
list a template's real field names and extend the mapping when a value comes
out blank. Generated PDFs are intentionally not flattened, so they stay
hand-editable. Adding another ACORD form (125/126/140…) = a new template
entry in [Settings.tsx](src/pages/Settings.tsx) + a mapping in `acord.ts`.

## Website lead intake

The public `submitWebLead` mutation (API-key auth, handled by
[amplify/functions/lead-intake](amplify/functions/lead-intake)) lets
protectmyhoa.com forms create leads directly; the handler forces
`stage=LEAD`, so the public surface can never touch existing data. The web
app calls it via `web/src/lib/crmLead.ts` (dual-write alongside the
FormSubmit email, fail-soft). Set `PUBLIC_CRM_API_URL` / `PUBLIC_CRM_API_KEY`
on the **web** Amplify app per environment (values from this app's
`amplify_outputs.json` → `data.url` / `data.api_key`). Note the API key
expires after 365 days and must be rotated.

## Next phases

1. **Role enforcement** — wire the Cognito groups into per-model auth rules.
2. **License expiration alerts** — data is already captured per producer.
3. **ACORD carrier-submission forms** (125/126/140) on the template+mapping
   engine above.
