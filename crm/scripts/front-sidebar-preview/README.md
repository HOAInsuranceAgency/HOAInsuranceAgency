# Front sidebar visual review

This preview renders the actual account communication sidebar with fictional fixtures. It has no CRM credentials or ability to send messages. Data resets on reload.

Run from `crm`:

```sh
npx vite --config scripts/front-sidebar-preview/vite.config.ts
```

Open http://127.0.0.1:8767. Choose an account situation and panel width to review assignment, communication history, notes, and conversation tools. Task screens, daily reports, and reminder emails are retired.

Rebuild the standalone HTML with `node scripts/build-workflow-ux-preview.mjs`. A preview does not verify provider ingestion or live delivery.
