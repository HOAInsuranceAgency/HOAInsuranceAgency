# Documents UI preview

From `crm`, run `npx vite --config scripts/documents-preview/vite.config.ts`, then open http://127.0.0.1:8785/.

The production DocumentsPanel, ExtractionPanel and FormsTab components render with fictional, in-memory data. CRM, storage and ACORD generation APIs are aliased to local fixtures. Uploads, renames, deletes, links, extraction and form generation change only these local fixtures. Refresh resets everything. Download creates a clearly marked local text placeholder, and file preview uses the production modal shell with sample content instead of fetching a signed file URL. No CRM API, storage request, AI call or external messaging runs.

Use `?scenario=empty`, `client`, `error`, or `loading`; the default is a populated lead. The error scenario fails the first document and generated-form load, so Retry can recover. The loading scenario intentionally stays pending. Extraction has sample scalar fields, matched and new contacts, losses and buildings; Re-run extraction and Apply update only memory.

Check desktop and mobile layouts, long filenames, link filters, rename/delete/upload, OCR text and table search, review disclosures, extraction selection, and form generation. This preview does not replace backend tests.
