# Sentry error monitoring

HOA uses the separate [HOA Insurance Agency organization](https://hoa-insurance-agency.sentry.io/issues/), with US data storage. It does not send events to BuzzKill.

| Project | Coverage | Amplify app |
| --- | --- | --- |
| `hoa-crm` | React errors, unhandled browser exceptions/rejections, including the Front sidebar | `HOAInsuranceAgency CRM` |
| `hoa-web` | Unhandled browser exceptions/rejections on public marketing pages | `HOAInsuranceAgency` |
| `hoa-backend` | Lambda exceptions, timeout warnings, returned HTTP 5xx, nonempty batch failures, worker failure counts, and selected unexpected handled job failures | `HOAInsuranceAgency CRM` |

The SDK is disabled when its DSN is empty. Development browsers are disabled unless `VITE_SENTRY_ENABLED=true` (CRM) or `PUBLIC_SENTRY_ENABLED=true` (website). These switches permit an intentional local test; they are not required in deployed builds. Backend migration previews remain disconnected even when a DSN exists in the build environment.

## Configuration

Use each project's **Settings → Client Keys (DSN)** in the HOA organization. DSNs identify the ingestion destination and are public client configuration. They are different from the secret upload token.

| Build environment variable | CRM app | Website app |
| --- | --- | --- |
| Browser DSN | `VITE_SENTRY_DSN` from `hoa-crm` | `PUBLIC_SENTRY_DSN` from `hoa-web` |
| Browser environment | `VITE_SENTRY_ENVIRONMENT` | `PUBLIC_SENTRY_ENVIRONMENT` |
| Backend DSN | `SENTRY_DSN` from `hoa-backend` | — |
| Backend environment | `SENTRY_ENVIRONMENT` | — |
| Source-map organization | `SENTRY_ORG=hoa-insurance-agency` | Same |
| Source-map project | `SENTRY_PROJECT=hoa-crm` | `SENTRY_PROJECT=hoa-web` |
| Private upload token | `SENTRY_AUTH_TOKEN` | `SENTRY_AUTH_TOKEN` |

Set environment labels explicitly to `production` on `main` and `staging` on retained staging branches. Preserve the existing branch overrides when editing Amplify settings. Both build configurations derive release from `AWS_COMMIT_ID`; `SENTRY_RELEASE` or the app-specific `VITE_SENTRY_RELEASE` / `PUBLIC_SENTRY_RELEASE` can override it for controlled testing. Do not leave a fixed release override on a deployed branch.

Use an organization token with `org:ci` scope for source-map uploads. Keep it in the Amplify build environment. Never prefix it with `VITE_` or `PUBLIC_`, put it in Git, or include it in a Lambda environment. The Vite plugin generates hidden browser maps only when token, organization, and project are all supplied; upload failures fail the build, and successful upload deletes the maps from `dist`. Amplify's Lambda bundles contain private source maps; Node resolves those locally through `--enable-source-maps`.

Configuration changes take effect on the next deployment. Setting Amplify variables alone does not instrument an already deployed bundle or Lambda. Follow the existing retained-staging migration and promotion process; the old `staging` branch is not the current retained staging deployment target. Do not deploy this integration by merging unrelated branch histories.

## Data collection and behavior

This rollout sends error diagnostics only. Replay, tracing, profiling, sessions, console logging, metrics, DOM breadcrumbs, customer identity, cookies, headers, request/response bodies, GraphQL variables, database payloads, AI content, and local variables are disabled. The shared event allowlist removes custom context, arbitrary tags, and free-form error text, retaining error type, stack locations, release, environment, and static service/function labels. HTTP breadcrumbs retain only origin, method, and status. Request paths, queries, fragments, and credentials are omitted. Repository source locations are normalized without build-machine home paths.

The private website routes `/documents`, `/finance`, and `/broker-fee` do not load Sentry. CRM login and iframe URLs are covered by the same URL scrubbing as every other CRM event.

The CRM shows a recovery screen for React render failures and never displays raw exception text. Every declared Lambda entrypoint has a thin monitored entry module; business handlers preserve their return values and retry behavior. Returned authorization/validation errors (`{ok:false}` or HTTP 4xx) do not automatically create issues. Unexpected errors that are deliberately caught and converted to business responses need an explicit `captureHandledFailure` call after expected-error guards. Existing CloudWatch alarms and worker recovery controls remain necessary; Sentry does not replace them.

## Verification

From `crm/`, run `npm run test:run`, `npm run typecheck:backend`, `npm run synth:check`, and `NODE_OPTIONS=--max-old-space-size=6144 npm run build`. The backend transport tests exercise the real SDK without network calls and check payload removal, rethrows, result identity, timeout warnings, and declared-entrypoint coverage. The synth check must also pass with a configured DSN/release and the retained staging settings, including Lambda's 4 KB environment limit.

From `web/`, run `npm run test:sentry`, `npm run articles:test`, `npm run typecheck`, `npm run build`, and `npm run seo:check`. Verify private route HTML has no monitoring module and no `.map` files are present in deployment artifacts.

For a live smoke test, use an isolated local build with a synthetic `SentrySetupSmokeTest` exception and `environment=integration-test`. Confirm its project and release in the HOA Issues screen. Test browser symbolication after uploading maps for that exact build. Do not add a production crash button, throw from a real financial workflow, or send customer data to test monitoring.

### Initial verification (November 4, 2026)

All 5,109 CRM tests passed, as did backend type checking, CRM build, website Sentry transport tests (3), article tests, website type checking/build, and the 163-page SEO comparison. Retained staging synth with the real backend DSN passed; its largest template was 984,749 bytes. Using the destination account's actual deployed communications environments, the proposed compact serialized environment is 3,804/4,096 bytes in production after alias removal and 4,050/4,096 in retained staging. Recheck that budget when adding environment settings.

Synthetic events were received in [CRM](https://hoa-insurance-agency.sentry.io/issues/7829999917/), [website](https://hoa-insurance-agency.sentry.io/issues/7830001766/), and [backend](https://hoa-insurance-agency.sentry.io/issues/7829999491/), with customer data absent. No application deployment was performed. Browser source-map upload and symbolication remain unverified until the CI token is configured.
