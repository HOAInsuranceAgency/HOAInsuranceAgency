# Commission workflow preview

## Opening the preview reliably

The 127.0.0.1 links are local addresses, not hosted URLs. They require the preview server on this computer and stop working after that process exits or the computer restarts.

From the repository's top folder, double-click **Open-Commission-Preview.cmd**. It builds the latest fictional preview and starts port 8792, or detects the existing preview. Keep its window open while testing. No AWS configuration or delivery is enabled. Open http://127.0.0.1:8792/?scenario=shared after it reports ready.

For a server-free copy, build the isolated preview, then run this from crm:

    node scripts/commissions-preview/package-offline.mjs

Open scripts/commissions-preview/dist/HOA_Commission_Preview.html in Chrome or Edge. The HTML contains its JavaScript, styles, logo, and font. Use the Sample scenario and Sample view selectors to switch between shared commissions, payment/report history, the basic ledger, and the employee view. This file can be copied to another computer without Node or a running server. It is a snapshot of the build and must be regenerated after source changes.

This remains a read-only demo. Display exports are available; saves, posting, payments, and archived private-report downloads are refused. Genuine authentication, persistence, and email acceptance need isolated staging.

The offline package passed DOM smoke checks for the Owner ledger/payroll/exceptions, payment history, and employee presentation, with no external asset dependencies. These checks do not replace real-browser visual acceptance.

From `crm`, run `npx vite --config scripts/commissions-preview/vite.config.ts --configLoader runner` and open http://127.0.0.1:8791/.

If the development dependency scanner cannot read parent folders on Windows, build and serve the same isolated preview instead:

```powershell
node node_modules/vite/bin/vite.js build --config scripts/commissions-preview/vite.config.ts --configLoader runner
node node_modules/vite/bin/vite.js preview --config scripts/commissions-preview/vite.config.ts --configLoader runner --host 127.0.0.1 --port 8792 --strictPort
```

Open http://127.0.0.1:8792/. This preview build does not require `amplify_outputs.json` and does not replace the full CRM build check.

Use `?scenario=exceptions` for a fictional approved revision, partial payment, archived report versions, and bounce feedback. The off-cycle draft and correction controls are visible, but all writes/downloads still refuse; these are sample records only.

This renders the production commission components with fictional in-memory records. Use `?role=producer` to inspect the producer statement view. No authentication, CRM requests, cloud storage, or payroll actions are performed. Save and download actions deliberately refuse. This preview supports visual checks; the service tests cover posting and authorization.

The Seaside HOA example has a partial carrier-supported schedule: $1,000 due
November 1, $900 received November 3, and $1,000 scheduled for December 1.
Review as of November 4, 2026 to see $100 overdue with the remaining unscheduled
estimate shown separately. The Cedar HOA example retains unknown legacy timing
and an adjustment requiring forecast review. All names and amounts are fictional.

The Owner view includes a reusable plan, dated assignment, October/November payroll calendars, and disabled report delivery. All preview mailboxes use `example.test`. The module mocks target only the CRM service files, preserving the real shared commission calculations and import mapping.

Use `?scenario=shared` to inspect a fictional 60%/40% allocation using 20%/16% individual rates ($120/$64 on a $1,000 agency receipt), the separate employee earnings ledger, and the departure-review workspace. Payroll totals use the real preview calculation. The payroll and exception screens use the CRM design tokens and responsive form layouts. No preview action can approve actual records or send email.

For step-by-step checks and exact expected amounts, see [the commission acceptance test plan](../../../docs/COMMISSION-ACCEPTANCE-TEST-PLAN.md). Ready-to-import fictional CSVs and the results log are in `acceptance-data/`. The localhost preview remains read-only; the full financial script requires isolated writable staging.

## Branded PDF samples

The preview launcher regenerates sample PDFs with the production payroll/departure renderers. The November 6 revised references are implemented by `report-layout.ts`; branding is embedded in `shared/commissionBrand.ts` and re-exported by `report-brand.ts` so delivery requires no remote assets or browser runtime. All preview copies use explicit `isTest: true`; archived production records keep their existing bytes.

Regenerate independently: `node scripts/commissions-preview/generate-report-samples.mjs`. Rebuild before packaging an offline HTML.

Run the packaged employee-view P04 check: `node scripts/commissions-preview/check-employee-preview.mjs <absolute-path-to-offline-html>`. This exercises the real packaged UI in a local DOM; it is not a substitute for an observed browser session or live authorization testing.

## Local statement mapping

The isolated preview replaces the private statement-attachment service with a local CSV/XLSX adapter (up to 5 MB). It performs no network upload and returns no evidence key. The actual importer still parses, maps, and applies draft lines; saves and posting remain unavailable. Production attachments retain conditional private upload and return evidence only after success. P06 was observed in Chrome with the two sample rows ($600 + $400 = $1,000), both Pending review.

## Branded ledger printout

Ledger > Download > Print / save PDF uses the same embedded HOA logo, address, navy/gold design and date panels as the revised payroll documents. Agency transactions and employee allocations remain separate; source IDs are retained in compact reference rows. The preview marks the printout TEST DATA — DO NOT PAY. This display export is not a payroll approval. The print stylesheet targets Letter pages; native PDF saving and page-break acceptance still require a manual Chrome check.

## Commission styling consistency

All production commission disclosures use `CommissionPanel` and its shared token-based styles. The ledger, reconciliation, settings, exception cases and payroll retain the same keyboard-accessible native details behavior. The November 6 consistency pass also styles conditional plan/carrier fields, uploads, confirmations, errors and legacy history. See `docs/COMMISSION-OBSERVED-TEST-RESULTS-2026-11-06.md` for verification scope; fresh browser visual acceptance remains pending.
