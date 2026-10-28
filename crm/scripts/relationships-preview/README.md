# Fictional Relationships preview

From `crm`, run `npx vite --config scripts/relationships-preview/vite.config.ts` and open `http://127.0.0.1:8787`.

This renders the actual directory, profile and management form against in-memory fictional data. It does not initialize Amplify or send requests to the CRM. Reload resets all changes. Use the backend tests for transaction/access correctness; the preview adapter only supports the visual walkthrough.
