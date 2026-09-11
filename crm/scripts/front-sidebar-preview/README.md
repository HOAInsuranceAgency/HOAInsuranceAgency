# Workflow visual review

This preview uses the actual Front sidebar, daily-report, team-routing and email-rendering components with fictional fixtures. It has no CRM credentials, provider connection or ability to send messages. Links are intercepted. Data resets on reload.

Open `docs/WORKFLOW-UX-TEST-WORKSPACE.html` directly in a browser, or run from `crm`:

```sh
npx vite --config scripts/front-sidebar-preview/vite.config.ts
```

Use http://127.0.0.1:8767. Choose a role, situation and panel width. Dates in report fixtures are frozen at September 14, 2026, 9 a.m. Eastern; the surrounding component's live overdue labels use the browser clock. Scenarios show what the screen looks like; they do not simulate provider delivery or a full database lifecycle.

Rebuild the shareable HTML after component changes:

```sh
node scripts/build-workflow-ux-preview.mjs
```

Follow `docs/WORKFLOW-UX-ACCEPTANCE.md` for visual and connected staging tests. Do not claim a preview pass proves email delivery, call ingestion or scheduled escalation.
