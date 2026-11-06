# Commission staging release — November 6, 2026

Target: codex-hoa-staging-migration on CRM Amplify app d1nuh9rw1hcuxo (HOA account 917680434255, us-east-1).
Staging URL: https://migration-staging.d1nuh9rw1hcuxo.amplifyapp.com
Integration base: 7194baf0b4aad51f8c319aef4e8486836fd61b53.

## Included
- Monthly and off-cycle payroll, partial payments, approved report versions, audit and delivery tracking.
- Reusable plan assignments, shared policy allocations, departure reviews, and evidenced adjustments using the confirmed agreement terms.
- Revised branded payroll/departure PDFs and producer ledger printout, plus consistent commission forms, panels and controls.
- Preserves newer staging carrier forecasts, broker fees, asynchronous report downloads, monitoring and retained-backend safeguards.
- Broker-fee settlements create shared employee earnings atomically with the receipt and payroll reconciliation version. Carrier and broker-fee cumulative rounding remain separate; refunds retain original allocation amounts.
- Generated sample PDFs, ZIPs, browser evidence, local AWS output configuration and local tooling settings are excluded from the commit. Preview commands regenerate their samples.

## Validation before push
- PASS: 498 targeted commission, broker-fee and report tests across 33 files.
- PASS: 131 financial integration checks.
- PASS: 19 monitoring/privacy regression tests.
- PASS: backend TypeScript and full CRM production build, including frontend TypeScript and Front sidebar build.
- PASS: generated PDF samples, preview build, offline packaging and packaged employee-view check ($440 total / $120 shared, other employee data and Owner controls absent).
- PASS: git diff --check.
- Local full synthesis could not finish because the existing Amplify branch-linker bundler produced no output on Windows. The unchanged Linux Amplify pipeline runs backend typecheck and full synthesis before deployment; its successful result remains required.

## Staging acceptance after deployment
Use COMMISSION-ACCEPTANCE-TEST-PLAN.md for writable workflow checks with fictional records. Confirm role enforcement, saves, archive downloads, audit/version history, concurrent edits, print pagination and responsive layout. Payroll email scheduling remains disabled on staging and delivery defaults off; live delivery/bounce acceptance requires a separately controlled test. No production deployment or business-data change is part of this release.

The earlier observed-test log is historical preview evidence; its statements about changes being local describe the state before this staging release.
