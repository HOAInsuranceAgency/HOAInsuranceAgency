import { defineFunction } from "@aws-amplify/backend";

/**
 * Reserves the next certificate number for a Certificate of Insurance.
 *
 * Numbers are formatted PREFIX-YEAR-NNNNN (e.g. HOA-2026-00011) and must be
 * unique for record keeping. Uniqueness is guaranteed by a single atomic
 * DynamoDB UpdateItem against a per-year counter (see backend.ts) — even two
 * COIs issued in the same instant get distinct, gap-free numbers.
 *
 * The year is taken from the server clock (not the client) so numbering can't
 * be tampered with. Per-year starting offsets (e.g. the 10 certificates issued
 * before this system existed) are seeded via CERT_SEQ_BASES.
 */
export const certNumber = defineFunction({
  name: "cert-number",
  entry: "./handler.ts",
  timeoutSeconds: 15,
  memoryMB: 256,
});
