# HOA CRM

Internal agency management system replacing EzLynx for the commercial
(association) book. Vite + React SPA on an AWS Amplify Gen 2 backend.

## Architecture

- **Auth** — Cognito email sign-in. Groups `ADMIN` / `STAFF` / `PRODUCER` exist
  as placeholders; privileges are not enforced yet. First login runs an
  onboarding flow ([src/pages/Onboarding.tsx](src/pages/Onboarding.tsx));
  producers must supply an NPN and at least one state license.
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

## Next phases

1. **COI PDF generation** — fill the ACORD 25 template from Policy +
   Certificate data in a Lambda (pdf-lib); the `Certificate` model and
   issuance history UI already exist. Requires the fillable ACORD 25 PDF
   (ACORD-licensed) dropped into the function's assets. Same pipeline then
   extends to other ACORD forms for carrier submissions (125/126/140…).
2. **Website → CRM lead intake** — a public `createLead` API path so
   protectmyhoa.com forms create `Account` records directly instead of
   FormSubmit emails.
3. **Role enforcement** — wire the Cognito groups into per-model auth rules.
4. **License expiration alerts** — data is already captured per producer.
