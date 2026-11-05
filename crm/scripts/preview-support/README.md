# Local preview setup

Each preview keeps its own fictional data, routing, role providers and error
scenarios. createPreviewConfig owns the repeated Vite setup; mountPreview
owns the DOM root mount. Module replacements match resolved source paths, so
moving a component deeper into a feature folder does not change its mock.

Declare the modules supplied by the scenario's fixtures.ts in modules.
Dedicated replacements belong in replacements. Real provider SDK imports
fail the build, an undeclared client cannot load, and default preview auth
denies privileged controls. A privileged scenario must explicitly supply its
auth replacement. Dev servers bind to loopback with each existing port and
public-directory setting.

Run npm run preview:check from crm to compile all nine real preview scenarios
without writing bundles or starting servers. The standard repository verifier
also runs it. Default production builds retain their own configuration and
never use these replacements.
