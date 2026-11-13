import {
  day,
  integer,
  MONEY_MAX,
  required,
  sum,
  type CommissionPolicy,
  type CommissionStatement,
} from "./commissions";
import { importedMoney, type StatementImportMapping } from "./commissionImport";

export const INTAKE_ROW_LIMIT = 1000;
export const INTAKE_EDIT_LIMIT = 20;
export const INTAKE_POST_LIMIT = 5;
export interface StatementIntake {
  id: string;
  version: number;
  carrierId: string;
  carrierName: string;
  reference: string;
  source: string;
  filename: string;
  fileHash: string;
  documentReceivedOn: string;
  statementDate?: string;
  totalCents?: number;
  createdAt: string;
  createdBy: string;
  status: "OPEN" | "VOID";
  voidReason?: string;
  rowCount: number;
  rowTotalCents: number;
  needsReview: number;
  unmatched: number;
  postedCents: number;
  completedRows: number;
  extractionJobId?: string;
}
export interface IntakeRow {
  id: string;
  version: number;
  intakeId: string;
  sourceRow?: number;
  policyNumber: string;
  effectiveDate: string;
  lineRef: string;
  policyId: string;
  agencyCents?: number;
  transactionType: "RECEIPT" | "REVERSAL" | "RESTORATION";
  originalId?: string;
  reviewStatus: "PENDING" | "ELIGIBLE" | "INELIGIBLE";
  note: string;
  postedCents: number;
  deleted?: boolean;
  raw?: string[];
  importIssue?: string;
}
export interface IntakeAllocation {
  rowId: string;
  amountCents: number;
}
export interface IntakeSettlement {
  id: string;
  version: number;
  intakeId: string;
  carrierId: string;
  reference: string;
  receivedOn: string;
  totalCents: number;
  settlementType: CommissionStatement["settlementType"];
  evidence: string;
  status: "RECORDED" | "POSTING" | "POSTED" | "VOID";
  voidReason?: string;
  allocations: IntakeAllocation[];
  postedRows: string[];
  statementIds: string[];
  createdAt: string;
  createdBy: string;
}
export interface CarrierImportTemplate {
  id: string;
  version: number;
  carrierId: string;
  headers: string[];
  mapping: StatementImportMapping;
}
export interface IntakeWorkspace {
  intakes: StatementIntake[];
  settlements: IntakeSettlement[];
  templates: CarrierImportTemplate[];
}
export const intakeRowsKind = (id: string) => "INTAKE_ROWS#" + id;
export const normalizePolicyNumber = (value: string) =>
  value.trim().toUpperCase();
export function exactPolicyMatches(
  row: Pick<IntakeRow, "policyNumber" | "effectiveDate">,
  carrierId: string,
  policies: CommissionPolicy[],
) {
  return policies.filter(
    (p) =>
      p.carrierId === carrierId &&
      normalizePolicyNumber(p.policyNumber) ===
        normalizePolicyNumber(row.policyNumber) &&
      (!row.effectiveDate || p.effectiveDate === row.effectiveDate),
  );
}
const optionalText = (value: unknown, label: string, max = 200) =>
  value === undefined || value === "" ? "" : required(value, label, max);
export function validateIntakeRow(
  input: IntakeRow,
  intakeId: string,
  previous?: IntakeRow,
): IntakeRow {
  const id = required(input.id, "a statement row ID", 100);
  if (!/^[A-Za-z0-9_-]+$/.test(id))
    throw new Error("Invalid statement row ID.");
  if (!["RECEIPT", "REVERSAL", "RESTORATION"].includes(input.transactionType))
    throw new Error("Choose a transaction type.");
  if (!["PENDING", "ELIGIBLE", "INELIGIBLE"].includes(input.reviewStatus))
    throw new Error("Choose a review decision.");
  const row: IntakeRow = {
    id,
    version: integer(input.version, 0, Number.MAX_SAFE_INTEGER, "row version"),
    intakeId,
    policyNumber: optionalText(input.policyNumber, "the policy number"),
    effectiveDate: input.effectiveDate ? day(input.effectiveDate) : "",
    lineRef: optionalText(
      input.lineRef,
      "the carrier transaction reference",
      200,
    ),
    policyId: optionalText(input.policyId, "the policy ID", 128),
    transactionType: input.transactionType,
    reviewStatus: input.reviewStatus,
    note: optionalText(input.note, "review notes", 2000),
    postedCents: previous?.postedCents ?? 0,
    ...(input.agencyCents !== undefined && input.agencyCents !== null
      ? {
          agencyCents: integer(
            input.agencyCents,
            -MONEY_MAX,
            MONEY_MAX,
            "agency commission",
          ),
        }
      : {}),
    ...(input.sourceRow !== undefined
      ? { sourceRow: integer(input.sourceRow, 1, 10000, "source row") }
      : {}),
    ...(input.originalId
      ? { originalId: required(input.originalId, "the original receipt", 500) }
      : {}),
    ...(input.deleted ? { deleted: true } : {}),
    ...(input.raw
      ? { raw: input.raw.slice(0, 5).map((v) => String(v).slice(0, 500)) }
      : {}),
    ...(input.importIssue
      ? { importIssue: required(input.importIssue, "import review note", 500) }
      : {}),
  };
  if (row.deleted && !row.note)
    throw new Error("Explain why this source row is excluded.");
  return row;
}
export function rowIssues(
  row: IntakeRow,
  carrierId: string,
  policies: CommissionPolicy[],
  allRows: IntakeRow[] = [row],
): string[] {
  if (row.deleted) return [];
  const problems: string[] = [];
  if (!row.lineRef) problems.push("Missing transaction reference");
  else if (
    allRows.some(
      (r) =>
        !r.deleted &&
        r.id !== row.id &&
        r.lineRef.toLowerCase() === row.lineRef.toLowerCase(),
    )
  )
    problems.push("Duplicate transaction reference");
  if (
    row.agencyCents === undefined ||
    row.agencyCents === 0 ||
    (row.transactionType === "REVERSAL"
      ? row.agencyCents > 0
      : row.agencyCents < 0)
  )
    problems.push("Review agency amount and sign");
  const policy = policies.find((p) => p.id === row.policyId);
  if (!policy || policy.carrierId !== carrierId)
    problems.push("Match a policy for this carrier");
  else {
    if (row.effectiveDate && row.effectiveDate !== policy.effectiveDate)
      problems.push("Policy term does not match");
    if (
      normalizePolicyNumber(row.policyNumber) !==
        normalizePolicyNumber(policy.policyNumber) &&
      !row.note
    )
      problems.push("Explain the source policy number difference");
  }
  if (row.importIssue) problems.push("Extracted source values need review");
  if (row.transactionType !== "RECEIPT" && !row.originalId)
    problems.push("Link the original receipt or reversal");
  if (row.reviewStatus === "PENDING")
    problems.push("Eligibility review required");
  if (
    (row.reviewStatus === "INELIGIBLE" || row.transactionType !== "RECEIPT") &&
    !row.note
  )
    problems.push("Explain this exception");
  return problems;
}
export function intakeSummary(
  rows: IntakeRow[],
  carrierId: string,
  policies: CommissionPolicy[],
) {
  const active = rows.filter((r) => !r.deleted);
  return {
    rowCount: active.length,
    rowTotalCents: sum(active.map((r) => r.agencyCents ?? 0)),
    unmatched: active.filter(
      (r) =>
        !policies.some((p) => p.id === r.policyId && p.carrierId === carrierId),
    ).length,
    needsReview: active.filter(
      (r) => rowIssues(r, carrierId, policies, active).length > 0,
    ).length,
    postedCents: sum(active.map((r) => r.postedCents)),
    completedRows: active.filter(
      (r) =>
        r.agencyCents !== undefined &&
        r.agencyCents !== 0 &&
        r.postedCents === r.agencyCents,
    ).length,
  };
}
export function reservedCents(
  rowId: string,
  settlements: IntakeSettlement[],
  exceptId?: string,
) {
  return sum(
    settlements
      .filter((s) => s.id !== exceptId && s.status !== "VOID")
      .flatMap((s) =>
        s.allocations
          .filter((a) => a.rowId === rowId)
          .map((a) => a.amountCents),
      ),
  );
}
export function validateSettlementAllocations(
  intake: StatementIntake,
  rows: IntakeRow[],
  settlements: IntakeSettlement[],
  settlement: IntakeSettlement,
  allocations: IntakeAllocation[],
  policies: CommissionPolicy[],
) {
  const active = rows.filter((r) => !r.deleted);
  if (
    !active.length ||
    active.some((r) => r.agencyCents === undefined) ||
    intake.totalCents === undefined ||
    sum(active.map((r) => r.agencyCents!)) !== intake.totalCents
  )
    throw new Error(
      "Complete the statement rows and reconcile their total to the original statement before posting.",
    );
  if (
    !Array.isArray(allocations) ||
    !allocations.length ||
    allocations.length > INTAKE_ROW_LIMIT ||
    new Set(allocations.map((a) => a.rowId)).size !== allocations.length
  )
    throw new Error("Allocate each statement row once per settlement.");
  for (const allocation of allocations) {
    const row = active.find((r) => r.id === allocation.rowId);
    if (!row)
      throw new Error("The allocated source row is no longer available.");
    const issues = rowIssues(row, intake.carrierId, policies, active);
    if (issues.length)
      throw new Error(
        "Row " + (row.sourceRow ?? row.id) + ": " + issues.join("; "),
      );
    integer(allocation.amountCents, -MONEY_MAX, MONEY_MAX, "allocated amount");
    const remaining =
      row.agencyCents! - reservedCents(row.id, settlements, settlement.id);
    if (
      !allocation.amountCents ||
      Math.sign(allocation.amountCents) !== Math.sign(remaining) ||
      Math.abs(allocation.amountCents) > Math.abs(remaining)
    )
      throw new Error(
        "An allocation exceeds the unallocated amount on its source row.",
      );
  }
  if (sum(allocations.map((a) => a.amountCents)) !== settlement.totalCents)
    throw new Error(
      "Allocated rows must equal this settlement’s verified agency commission total.",
    );
}
/** Only recorded cash/retained commission blocks payroll; an unpaid inbox item never does. */
export function intakePayrollStatements(
  settlements: IntakeSettlement[],
): CommissionStatement[] {
  return settlements
    .filter((s) => s.status === "RECORDED" || s.status === "POSTING")
    .map((s) => ({
      id: s.id,
      version: s.version,
      carrierId: s.carrierId,
      reference: "settlement " + s.reference + " (statement inbox)",
      source: "",
      receivedOn: s.receivedOn,
      settlementRef: s.reference,
      settlementType: s.settlementType,
      totalCents: s.totalCents,
      lines: [],
      status: "DRAFT",
    }));
}
export function reuseImportMapping(
  headers: string[],
  template?: CarrierImportTemplate,
): StatementImportMapping {
  const result: StatementImportMapping = {
    policy: -1,
    reference: -1,
    amount: -1,
    effective: -1,
    transaction: -1,
  };
  if (!template) return result;
  for (const key of Object.keys(result) as (keyof StatementImportMapping)[]) {
    const old = template.headers[template.mapping[key]]?.trim().toLowerCase();
    const matches = headers
      .map((h, i) => (h.trim().toLowerCase() === old ? i : -1))
      .filter((i) => i >= 0);
    if (old && matches.length === 1) result[key] = matches[0];
  }
  return result;
}
/** Preserve invalid source rows for correction; never silently drop money from an import. */
export function prepareIntakeRows(
  table: string[][],
  mapping: StatementImportMapping,
  intakeId: string,
  sheet: number,
  policies: CommissionPolicy[],
  carrierId: string,
): IntakeRow[] {
  if (table.length < 2 || table.length > INTAKE_ROW_LIMIT + 1)
    throw new Error("Import a header and up to 1,000 transaction rows.");
  const selected = Object.values(mapping).filter((i) => i >= 0);
  if (
    ["policy", "reference", "amount"].some(
      (k) => mapping[k as keyof StatementImportMapping] < 0,
    ) ||
    new Set(selected).size !== selected.length ||
    selected.some((i) => !Number.isInteger(i) || i >= table[0].length)
  )
    throw new Error(
      "Map distinct policy, transaction reference, and agency commission columns.",
    );
  return table.slice(1).flatMap((source, index) => {
    if (!source.some((c) => c.trim())) return [];
    const cell = (key: keyof StatementImportMapping) =>
      source[mapping[key]]?.trim() ?? "";
    const row: IntakeRow = {
      id: "import-" + sheet + "-" + (index + 2),
      version: 0,
      intakeId,
      sourceRow: index + 2,
      policyNumber: cell("policy"),
      effectiveDate: "",
      lineRef: cell("reference"),
      policyId: "",
      transactionType: "RECEIPT",
      reviewStatus: "PENDING",
      note: "",
      postedCents: 0,
      raw: [
        cell("policy"),
        cell("reference"),
        cell("amount"),
        cell("effective"),
        cell("transaction"),
      ],
    };
    const issues: string[] = [];
    try {
      row.agencyCents = importedMoney(cell("amount"));
    } catch {
      issues.push("Correct the imported agency amount");
    }
    try {
      row.effectiveDate = cell("effective") ? day(cell("effective")) : "";
    } catch {
      issues.push("Confirm the policy effective date");
    }
    const type = cell("transaction").toUpperCase();
    if (type === "REVERSAL" || type === "RESTORATION")
      row.transactionType = type;
    else if (
      mapping.transaction >= 0 &&
      !["RECEIPT", "COMMISSION", "NEW", "RENEWAL"].includes(type)
    )
      issues.push("Confirm the imported transaction type");
    const matches = exactPolicyMatches(row, carrierId, policies);
    if (matches.length === 1 && !issues.length) row.policyId = matches[0].id;
    if (issues.length) row.importIssue = issues.join("; ");
    return [row];
  });
}
