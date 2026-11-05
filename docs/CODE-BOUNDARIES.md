# Code boundaries and verification

Keep reusable visual controls in `crm/src/components/ui`, browser state and API
adapters in `crm/src/lib`, server infrastructure under `crm/amplify`, and pure
business rules and cross-app contracts in `shared`. Feature components compose
those layers and retain their domain-specific workflow decisions.

`npm run verify` is the repository's standard validation entry point. Its plan is
defined in `scripts/verify.mjs`; `.github/workflows/verify.yml` runs that same plan
for every PR targeting main or staging. Both app dependency sets are installed
from their existing lockfiles; there is no third dependency installation.

The verifier runs the existing tests and compilation/build commands. Backend
synthesis uses non-secret settings from the retained deployment contracts and
writes only temporary local build output. Those settings are not deployment
credentials or permission to invoke a deployment. Live retained-resource checks
in the Amplify release pipeline remain separate from this offline verification.
For a clean checkout, verification temporarily creates the minimal generated
Amplify outputs module needed by mocked tests and the offline browser build.
It preserves existing outputs and removes only its unchanged fixture on completion.

Architecture rules enforced by `scripts/check-module-boundaries.mjs`:

- Shared business rules import only other shared modules. Pass configuration and
  data into these rules instead of accessing browser storage or process.env.
- UI primitives depend on other primitives and UI libraries, rather than feature
  components, pages, or API/data helpers.
- Browser code cannot load deployment resources or executable Lambda entrypoints.
  Generated schema imports are type-only.
- Lambda handlers cannot import the browser SDK-initializing client module.

The checker inspects TypeScript syntax, including re-exports, require and dynamic
imports, plus executable browser scripts in Astro pages. Build-time frontmatter
and JSON-LD are handled separately. Its tests introduce forbidden dependencies and
verify they are caught, including deployed Lambda monitoring wrappers.
The existing control architecture suite additionally checks native controls,
inline styling, CSS recipes and component usage.

Pure rules should have one implementation with tests at their meaningful
boundaries. Keep permission checks, payment idempotency, uncertain-send recovery,
financial reconciliation, and notification audiences in the server domains that
own them. A shared transport or storage helper must not automatically retry a
financial command or weaken those contracts.

Historical audit reports explain prior decisions; use current code, current
verification commands, and this document for maintained boundaries.
