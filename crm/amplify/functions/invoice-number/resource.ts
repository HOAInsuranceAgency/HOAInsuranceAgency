import { defineFunction } from "@aws-amplify/backend";

/**
 * Reserves the next invoice number.
 *
 * Formatted PREFIX-YEAR-NNNNN (e.g. INV-2026-00001). Uniqueness comes from a
 * single atomic DynamoDB UpdateItem against a per-year counter (see
 * backend.ts), so two producers creating invoices in the same instant get
 * distinct numbers.
 *
 * The year is the server's, not the caller's, so numbering cannot be steered by
 * a wrong clock on someone's laptop. Per-year offsets for numbering that
 * predates this system are seeded via INVOICE_SEQ_BASES.
 */
export const invoiceNumber = defineFunction({
  name: "invoice-number",
  entry: "./handler.ts",
  timeoutSeconds: 15,
  memoryMB: 256,
});
