import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

/**
 * Custom mutation handler: reserveInvoiceNumber.
 *
 * A single UpdateItem is atomic in DynamoDB, so concurrent callers always
 * receive distinct, sequential numbers — no read/modify/write race and no
 * duplicates. Two people creating invoices at the same moment is the ordinary
 * case in an agency, not an edge one.
 *
 * ── Why this is not `cert-number` with an argument ──────────────────────────
 * It is the same forty lines, and that was tempting. But generalising it means
 * renaming `certSeqTable`, and renaming a CDK Table construct changes its
 * logical id, which replaces the table. That would reset the certificate
 * counter and start re-issuing numbers that are already printed on certificates
 * sitting in carriers' files. A duplicated counter is cheap; a duplicated
 * certificate number is a regulatory problem.
 *
 * ── Numbers are reserved, not assigned on send ──────────────────────────────
 * A reserved number can end up on a voided invoice, leaving a gap in the
 * sequence. That is correct: gaps are explainable and reuse is not. VOID exists
 * on InvoiceStatus for exactly this reason — the row stays so the number is
 * never handed out twice.
 */

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient());

const TABLE = process.env.SEQ_TABLE as string;
const PREFIX = process.env.INVOICE_PREFIX ?? "INV";

/**
 * Per-year starting offsets, for numbering that predates this system.
 * `{"2026": 40}` → the first invoice issued in 2026 is INV-2026-00041.
 */
const BASES: Record<string, number> = (() => {
  try {
    return JSON.parse(process.env.INVOICE_SEQ_BASES ?? "{}");
  } catch {
    return {};
  }
})();

export const handler = async (): Promise<{
  invoiceNumber: string;
  year: string;
  seq: number;
}> => {
  const year = String(new Date().getUTCFullYear());
  const base = BASES[year] ?? 0;

  const res = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { year },
      // `if_not_exists` seeds the counter to `base` the first time a year is
      // used; every call after that just adds one to the stored value.
      UpdateExpression: "SET seq = if_not_exists(seq, :base) + :one",
      ExpressionAttributeValues: { ":base": base, ":one": 1 },
      ReturnValues: "UPDATED_NEW",
    })
  );

  const seq = Number(res.Attributes?.seq ?? base + 1);
  return {
    invoiceNumber: `${PREFIX}-${year}-${String(seq).padStart(5, "0")}`,
    year,
    seq,
  };
};
