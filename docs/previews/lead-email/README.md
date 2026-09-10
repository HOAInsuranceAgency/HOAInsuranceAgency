# Internal lead email

The Front website intake message now presents contact information, property details, coverage needs, and readable notes using the agency's navy and gold. Empty fields, duplicate answers, raw JSON, and technical IDs are omitted from the visible email. The original submission snapshot stays intact.

The layout supports the quote wizard, assessment, contact, association HO-6, and coverage calculator forms. Additional human answers remain visible. CRM links retain the submission reference internally; the import's exact Front message UID is still required before ingestion treats it as an internal form message.

## Preview

Open [the desktop and phone preview](index.html), [HO-6 email](ho6.html), or [association email](association.html). These contain fictional examples and do not send anything.

Regenerate from `crm` with `npx tsx scripts/preview-intake-email.ts`.

## Verified September 10, 2026

- 1,981 tests across 101 files passed, including all five form types, escaping, field preservation, HTML import, and import recognition with a missing UID index.
- Frontend build/typecheck, backend typecheck, and backend synthesis passed.
- Staging code commit: `b02bb9b`. CRM Amplify job 181 and website job 180 succeeded. Production was not deployed.
- Submitted `TEST Lead Brief 0910` through the staging HO-6 form using the approved test contact.
- Inspected the actual HTML in Front: header, contact links, property, carrier, paragraph breaks, and formatted Eastern time rendered correctly. Clicking the CRM button opened the matching lead.
- Front conversation contains exactly one imported form and one confirmed AI reply from Brian Cole. The internal brief was not quoted into the prospect-facing reply. One normal follow-up was created; the form did not create a false response task.
- [Open the live Front test conversation](https://app.frontapp.com/open/cnv_1hy0xnkq).

The new format applies to new imports. Previously imported emails retain their original contents.
