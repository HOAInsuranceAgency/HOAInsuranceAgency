# Front sidebar visual preview

From `crm`, run `npx vite --config scripts/front-sidebar-preview/vite.config.ts` and open `http://127.0.0.1:8767/`.

This renders the actual sidebar components and app stylesheet at 260, 340, and 440 pixels using fictional data. The isolated Vite aliases replace the CRM client and Front SDK: forms do not send messages or change real records. The preview is not part of the deployed application.

Check the default view, team editing, action editing and completion, activity, notes, conversation tools, text draft, and lead linking. Automated behavior checks live in `src/test/communicationUi.test.tsx`; live staging verification is still needed for the real Front context.
