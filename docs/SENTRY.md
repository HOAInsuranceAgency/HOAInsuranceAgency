# Sentry error monitoring

HOA monitoring configuration targets the shared [Master Planning organization](https://master-planning.sentry.io/issues/) (`master-planning`, organization ID `4512373753249792`). Its three HOA projects belong only to the `#hoainsuranceagency` Sentry team. Organization, Slack alert delivery, and application deployment are verified separately; the evidence sections below identify which configuration and deployment each check covers. Historical events remain in the original [HOA Insurance Agency organization](https://hoa-insurance-agency.sentry.io/issues/).

| Original project | Created Master Planning project | Coverage | Amplify app |
| --- | --- | --- | --- |
| `hoa-crm` | `hoainsuranceagency-crm` (`4512376858345472`) | React errors, unhandled browser exceptions/rejections, including the Front sidebar | `HOAInsuranceAgency CRM` |
| `hoa-web` | `hoainsuranceagency-web` (`4512376861425664`) | Unhandled browser exceptions/rejections on public marketing pages | `HOAInsuranceAgency` |
| `hoa-backend` | `hoainsuranceagency-backend` (`4512376864702464`) | Lambda exceptions, timeout warnings, returned HTTP 5xx, nonempty batch failures, worker failure counts, and selected unexpected handled job failures | `HOAInsuranceAgency CRM` |

The SDK is disabled when its DSN is empty. Development browsers are disabled unless `VITE_SENTRY_ENABLED=true` (CRM) or `PUBLIC_SENTRY_ENABLED=true` (website). These switches permit an intentional local test; they are not required in deployed builds. Backend migration previews remain disconnected even when a DSN exists in the build environment.

## Configuration

Use each project's **Settings → Client Keys (DSN)** in Master Planning. DSNs identify the ingestion destination and are public client configuration. They are different from the secret upload token.

| Master Planning project | Public client DSN |
| --- | --- |
| `hoainsuranceagency-crm` | `https://946e960505a3e8028169cf5e8171cb2e@o4512373753249792.ingest.us.sentry.io/4512376858345472` |
| `hoainsuranceagency-web` | `https://3de7bb5115422f9fa3058c7c4099df69@o4512373753249792.ingest.us.sentry.io/4512376861425664` |
| `hoainsuranceagency-backend` | `https://b54572b69a2f982dcc3f850a27306956@o4512373753249792.ingest.us.sentry.io/4512376864702464` |

| Build environment variable | CRM app | Website app |
| --- | --- | --- |
| Browser DSN | `VITE_SENTRY_DSN` from `hoainsuranceagency-crm` | `PUBLIC_SENTRY_DSN` from `hoainsuranceagency-web` |
| Browser environment | `VITE_SENTRY_ENVIRONMENT` | `PUBLIC_SENTRY_ENVIRONMENT` |
| Backend DSN | `SENTRY_DSN` from `hoainsuranceagency-backend` | — |
| Backend environment | `SENTRY_ENVIRONMENT` | — |
| Source-map organization | `SENTRY_ORG=master-planning` | Same |
| Source-map project | `SENTRY_PROJECT=hoainsuranceagency-crm` | `SENTRY_PROJECT=hoainsuranceagency-web` |
| Private upload token | `SENTRY_AUTH_TOKEN` | `SENTRY_AUTH_TOKEN` |

Set environment labels explicitly to `production` on `main` and `staging` on retained staging branches. Preserve the existing branch overrides when editing Amplify settings. Both build configurations derive release from `AWS_COMMIT_ID`; `SENTRY_RELEASE` or the app-specific `VITE_SENTRY_RELEASE` / `PUBLIC_SENTRY_RELEASE` can override it for controlled testing. Do not leave a fixed release override on a deployed branch.

Use an organization token with `org:ci` scope for source-map uploads. This credential cannot be restricted to individual projects within its organization. Separate CRM and website token names provide audit and rotation identities, not project-level permission isolation. Store each token only in its Amplify build environment. Never prefix it with `VITE_` or `PUBLIC_`, put it in Git, or include it in a Lambda environment or other runtime. The Vite plugin generates hidden browser maps only when token, organization, and project are all supplied; the explicit throwing error handler stops the build on upload errors, and successful upload deletes the maps from `dist`. Amplify's Lambda bundles contain private source maps; Node resolves those locally through `--enable-source-maps`.

The approved Master Planning CI token records are `1218579` for CRM and `1218580` for the website. Provision the corresponding secret into each app's `SENTRY_AUTH_TOKEN` build setting, preserving unrelated app and branch variables. A token record ID is not the secret itself. Verify staging first, then production, using matching DSN, organization, project, environment, and exact release values.

Configuration changes take effect on the next deployment. Setting Amplify variables alone does not instrument an already deployed bundle or Lambda. Follow the existing retained-staging migration and promotion process; the old `staging` branch is not the current retained staging deployment target. Do not deploy this integration by merging unrelated branch histories.

## Shared organization and Slack alerts

Keep HOA events in the three `hoainsuranceagency-*` projects, with explicit `staging` and `production` environment labels and environment-specific issue grouping. Preserve the original HOA organization, project keys, events, and fallback alerts while validating replacement deployments.

The dedicated private alert channel is `#sentry-hoainsuranceagency` (`C0CF1GHC91Q`) in the **Master Planning** Slack workspace (`T0C66F8M9U3`). The connected Slack API may still show that workspace's old name, **ERP**; use the exact workspace ID when scoping operations. Routing uses the existing shared Sentry Slack integration `554622` and its existing bot `U0CEWEMKMJR`, which is a member of the private channel. No separate Slack app was installed.

Configure the existing **HOA production errors** rule (`6293873`) for the three HOA projects and only `production`. Its trigger must be **An event or issue activity is captured**, with an **event level of error or fatal** filter, rather than only new issues, regressions or priority changes. This includes continuing errors on an already unresolved issue without paging for resolution or Seer activity alone. Keep native integration `554622`, exact Slack channel ID `C0CF1GHC91Q`, Jake's explicit email action, and the 60-minute per-issue throttle. Edit the existing rule so a new error does not notify through two overlapping rules. The all-environment default rules `6293868` (CRM) and `6293871` (website) remain disabled; original HOA alert fallbacks remain unchanged.

The throttle limits repeated qualifying notifications; it does not schedule reminders. Continuing errors need a new captured event to qualify again. The communications monitor forwards unchanged failures hourly, so a threshold requiring more than one event per hour would miss that failure. A reason change may forward immediately, but it does not bypass Sentry's notification throttle. Sentry rule configuration is separate from the application deployment and must be verified in the live console after changes.

Verify ingestion and source-map resolution for every project/environment, then verify a synthetic production alert reaches that private channel. Staging events should ingest without triggering the production rule. Keep existing CloudWatch alarms, SNS/email fallback, and worker recovery controls active.

For recurring-alert verification, observe a production event on an **already unresolved issue** in both the rule's trigger history and its Slack thread. A new issue, a manually resolved/regressed issue, or the **Send Test Notification** button proves different behavior and is insufficient on its own. Use the naturally recurring monitor event when available. A clearly labelled synthetic warning can instead establish an unresolved issue without notifying under the error-level filter; confirm that state before submitting an error with the same fingerprint. If an earlier event notified, wait for its throttle window before testing another eligible notification. A further error within the window must not notify again. Never force a customer workflow to fail or weaken the production throttle for a test. Record the issue, event, rule history, Slack timestamp and verification time separately from the deployment commit.

## Data collection and behavior

This rollout sends error diagnostics only. Replay, tracing, profiling, sessions, console logging, metrics, DOM breadcrumbs, customer identity, cookies, headers, request/response bodies, GraphQL variables, database payloads, AI content, and local variables are disabled. The shared event allowlist removes custom context, arbitrary tags, and free-form error text, retaining error type, stack locations, release, environment, and static service/function labels. HTTP breadcrumbs retain only origin, method, and status. Request paths, queries, fragments, and credentials are omitted. Repository source locations are normalized without build-machine home paths.

The shared organization and HOA projects require verified server-side scrubbing, default scrubbers, and IP-address suppression. Sensitive fields to check include `city`, `subdivision`, `region`, `country_code`, and `ip_address`: Sentry can otherwise infer location from the incoming connection even when the SDK omits user data. These are migration verification requirements, not a claim that new global Master Planning settings have been applied. Check effective inherited and HOA project settings while preserving the shared organization's other businesses. Scrubbing changes affect new events after propagation and do not rewrite earlier events.

The private website routes `/documents`, `/finance`, and `/broker-fee` do not load Sentry. CRM login and iframe URLs are covered by the same URL scrubbing as every other CRM event.

The CRM shows a recovery screen for React render failures and never displays raw exception text. Every declared Lambda entrypoint has a thin monitored entry module; business handlers preserve their return values and retry behavior. Returned authorization/validation errors (`{ok:false}` or HTTP 4xx) do not automatically create issues. Unexpected errors that are deliberately caught and converted to business responses need an explicit `captureHandledFailure` call after expected-error guards. Existing CloudWatch alarms and worker recovery controls remain necessary; Sentry does not replace them.

Deduplication applies only to unchanged communications monitor health failures. After a successful system-health checkpoint, Sentry receives an hourly forwarding attempt; reason changes and recurrence after a recorded recovery report immediately. Storage or routing failures deliberately allow extra diagnostics. No customer records change, and every unhealthy run still throws and logs for the existing CloudWatch/SNS/email path. A saved forwarding attempt is not a delivery acknowledgment.

Unsupported Front control receipts, such as `conversation_merged`, have no business projection and may omit `emitted_at`. After the row's inherited-work hold passes, acknowledge these existing no-op event types before checking provider timestamps. Supported message/assignment events still require their existing provenance checks. The ordinary worker then retains the receipt with `processedAt` and removes its due/work indexes; do not delete it, replay customer messages, or clear `lagging` to conceal the backlog. Verify the receipt drains and the following worker and independent monitor runs report healthy.

## Verification

From `crm/`, run `npm run test:run`, `npm run typecheck:backend`, `npm run synth:check`, and `NODE_OPTIONS=--max-old-space-size=6144 npm run build`. The backend transport tests exercise the real SDK without network calls and check payload removal, rethrows, result identity, timeout warnings, and declared-entrypoint coverage. The synth check must also pass with a configured DSN/release and the retained staging settings, including Lambda's 4 KB environment limit.

From `web/`, run `npm run test:sentry`, `npm run articles:test`, `npm run typecheck`, `npm run build`, and `npm run seo:check`. Verify private route HTML has no monitoring module and no `.map` files are present in deployment artifacts.

For a live smoke test, use an isolated local build with a synthetic `SentrySetupSmokeTest` exception and `environment=integration-test`. Confirm its organization, project, and release in the destination Issues screen. Test browser symbolication after uploading maps for that exact build. Do not add a production crash button, throw from a real financial workflow, or send customer data to test monitoring.

### Initial local verification in the original HOA organization (November 4, 2026)

All 5,109 CRM tests passed, as did backend type checking, CRM build, website Sentry transport tests (3), article tests, website type checking/build, and the 163-page SEO comparison. Retained staging synth with the real backend DSN passed; its largest template was 984,749 bytes. Using the destination account's actual deployed communications environments, the proposed compact serialized environment is 3,804/4,096 bytes in production after alias removal and 4,050/4,096 in retained staging. Recheck that budget when adding environment settings.

Synthetic events were received in [CRM](https://hoa-insurance-agency.sentry.io/issues/7829999917/), [website](https://hoa-insurance-agency.sentry.io/issues/7830001766/), and [backend](https://hoa-insurance-agency.sentry.io/issues/7829999491/). No application deployment had been performed at this initial local-verification checkpoint.

At that checkpoint, the approved `hoa-amplify-sourcemaps` organization token (`org:ci`) was configured and verified in both Amplify apps, with no conflicting branch overrides. Both actual application builds uploaded source maps successfully, deleted all output maps, and contained no upload token in their artifacts. Isolated browser tests confirmed original source locations in Sentry: [CRM `main.ts:20`](https://hoa-insurance-agency.sentry.io/issues/7830022993/) and [website `main.ts:10`](https://hoa-insurance-agency.sentry.io/issues/7830023047/). These events use `environment=integration-test`, release `sourcemap-smoke@b0c8cf364a636c75cb1e5d7258ffd53424038e95`, and synthetic content only.

### Historical staging and production rollout in the original HOA organization

[PR #112](https://github.com/HOAInsuranceAgency/HOAInsuranceAgency/pull/112) subsequently merged as `939edfd8f6777faee2e1da9ef3134aa4cabcc147`. Retained staging deployed and verified `efa1262ca17e1c1a4ca946a94cfa9b77756569d1` (CRM job `26`, website job `6`); production deployed and verified the merged commit (CRM job `18`, website job `15`). All 144 rollout checks passed, including project/environment/release matching, source-map handling, private-route exclusions, synthetic event delivery, and controlled Lambda smoke tests. Website analytics stayed disabled in staging and enabled in production. This evidence predates the Master Planning migration.

The local evidence manifest is `/Users/jake/.codex/visualizations/2026/11/05/01a1a931-85e7-74a2-b2d1-f4b3dd1115e1/sentry-rollout/verification.json`. It records the original organization, exact deployment commits, synthetic event IDs, asset checksums, and verification limits. Existing communication-monitor errors and worker lag preceded this rollout; the verification did not claim to repair those business conditions.

### Master Planning alert-routing verification checkpoint

Three matched staging synthetic events ingested without Slack notifications. Three production synthetic events then produced three actual messages in the dedicated private channel: [CRM issue `7830114679`](https://master-planning.sentry.io/issues/7830114679/), [website issue `7830114675`](https://master-planning.sentry.io/issues/7830114675/), and [backend issue `7830114691`](https://master-planning.sentry.io/issues/7830114691/). All six synthetic issues were resolved after verification. The production backend event JSON showed a `production` environment fingerprint, no request or extra payload, and filtered country/region fields. This is sampled event evidence, not a claim that new global shared-organization settings were applied.

At this checkpoint, the approved per-app CI credentials were configured in retained-staging branch overrides; production defaults still used the original HOA configuration. These checks verified direct synthetic ingestion and alert routing, without a new application deployment to Master Planning. Deployment proof must separately identify the actual deployed commit, runtime DSNs, release, and environment.

Alert configuration, event JSON, and delivery evidence are retained locally in `/Users/jake/.codex/visualizations/2026/11/05/01a1a931-85e7-74a2-b2d1-f4b3dd1115e1/shared-sentry-migration`. Keep this alert-routing evidence separate from the original deployment manifest above.
