# Dependency review — September 7, 2026

This records the release-readiness dependency work, not a blanket security
certification. Audit results are registry snapshots and must be rerun when the
lockfiles or advisory database change.

## Resolved repository work

| Audit | Before | Reviewed installation |
| --- | --- | --- |
| Web, `npm audit --omit=dev` | 9 high, 2 low | 0 findings |
| Web, full `npm audit` | Not used as the initial baseline | 0 findings |
| CRM, `npm audit --omit=dev` | 2 high | 0 findings |
| CRM, full `npm audit` | Outside the targeted router baseline | 3 moderate, 21 high, 1 critical remain |

- CRM `react-router-dom` and its `react-router` lockfile resolution are **7.18.3**;
  the manifest now requires `^7.18.3`. This is the current patched 7.x release,
  without a major-version upgrade or downgrade. The reported
  [RSC CSRF advisory](https://github.com/remix-run/react-router/security/advisories/GHSA-qwww-vcr4-c8h2)
  was fixed in 7.18.2. This application uses declarative `BrowserRouter`, not the
  affected unstable RSC APIs, but the vulnerable dependency was upgraded anyway.
- The website moved from Astro 5.18.1 to **Astro 7.3.1**, with official integrations
  **`@astrojs/react` 6.0.5** and **`@astrojs/sitemap` 3.7.4**, and the transitive
  SVGO resolution is **4.1.0**. The
  [Astro 6 migration guide](https://docs.astro.build/en/guides/upgrade-to/v6/) and
  [Astro 7 migration guide](https://docs.astro.build/en/guides/upgrade-to/v7/)
  inform the migration. The site remains a fully static build; no server adapter
  was introduced. No web advisories were suppressed or accepted on the basis of
  static-build reachability: the reviewed full web audit is clean.
- `amplify.yml` now selects Node **22** before installation in both application
  pipelines. Node **22.23.2** is the release-verification runtime, compatible with
  Astro's requirements and CRM's build-time CloudFormation validator, which
  requires `^22.15.0`. This is a repository build configuration change, not an
  Amplify console change.
- Ordinary npm installation refreshed the existing development-only
  `@opentelemetry/core` override resolution from 2.10.0 to 2.11.0. The override
  itself was not changed. Retaining the old resolution caused `npm ci` to reject
  the lockfile; the generated resolution passed a clean install.

## Remaining CRM build-toolchain risk

The full CRM audit is **not clean**. Its 25 affected-package entries include
inherited reports on Amplify/GraphQL parent packages; they are not 25 distinct
runtime vulnerabilities. Every flagged installed instance belongs to the
development/build dependency tree. The clean production audit does not prove
that deployment tooling is safe or that every Lambda artifact has been audited.

The critical finding is **Handlebars 4.7.7**, pinned exactly by
`@aws-amplify/graphql-docs-generator@4.2.1`, reached through Amplify backend-data /
GraphQL generation and the backend CLI. The
[critical AST-injection advisory](https://github.com/handlebars-lang/handlebars.js/security/advisories/GHSA-2w6w-674q-4c4q)
requires an attacker-controlled pre-parsed AST supplied to `Handlebars.compile()`;
the fix is 4.7.9. Inspection of the installed generator's `lib/index.js` found
that it compiles constant template strings from
`lib/generator/utils/templates.js`, registers constant partials, and uses the
`lowerCaseFirstLetter` helper. Repository-controlled GraphQL schema data becomes
template context, not a caller-supplied compiler AST. No direct Handlebars import
or user-supplied template/AST compilation endpoint was found in the CRM frontend
or Lambda handler source. The related partial-block advisory likewise needs
template/context mutation not observed in those constant templates.

Other root findings are:

| Installed vulnerable package | Dependency path / observed exposure |
| --- | --- |
| `immutable` 3.7.6 | Pinned by `@ardatan/relay-compiler` 12; GraphQL code generation. |
| `lodash` 4.17.23, two nested copies | Pinned to the 4.17 line by GraphQL codegen plugin helpers; the runtime 4.18.1 copy is not flagged. |
| `mysql2` 3.9.9 | Pinned by Amplify GraphQL schema generation; SQL introspection. No SQL/MySQL configuration or imports were found in the application backend. |
| `brace-expansion` 1.1.16 / 2.1.2 / 5.0.7 | Glob, archive, cleanup, and CDK tooling; malicious expansion patterns can affect build availability. |
| `fast-uri` 3.1.4 | Ajv / CDK validation tooling; URI confusion findings remain in the installed build tree. |
| `nanoid` 3.3.16 | PostCSS dependency; the reported custom-generator zero-size path was not identified in application code. |
| `postcss` 8.5.22 | Vite CSS build tooling. The current advisory requires hostile `sourceMappingURL` with `from` unset; Vite's inspected `runPostCSS` explicitly sets `from` and `to` to the source file. |

These observations narrow exposure; they are **not an assertion of universal
unreachability**. Amplify code generation and deployment tooling execute in a
privileged build environment. Compromised dependencies, untrusted schema,
templates, CSS, or build configuration can change these assumptions. Keep
deployment inputs reviewed and trusted, avoid running credentialed deployment
jobs on untrusted contributions, and track an upstream-compatible toolchain
remediation separately.

`npm audit fix --force` was not used. npm's proposed parent-package resolutions
included downgrading the Amplify backend CLI to 0.11.1 and backend to 1.8.0; those
were rejected. No new security-suppressing overrides were added, and exact or
minor-line upstream pins were not blindly forced across their compatibility
boundaries. This targeted pass therefore resolves both production audits while
explicitly retaining the CRM build-toolchain findings for follow-up.
