/** Owner-only compensation contracts. Never include these in public team data. */
export interface CompensationTerm {
  from: string;
  /** Inclusive last day of employment/rate; omitted means ongoing. */
  to?: string;
  annualSalaryCents: number;
  /** Percentage of agency commission, in basis points; 2500 means 25%. */
  producerShareBps: number;
}
export interface EmployeeCompensation {
  userId: string;
  version: number;
  terms: CompensationTerm[];
}
export interface ProfitabilityEmployee { userId: string; name: string }
export interface ProfitabilityPolicy {
  id: string;
  accountId: string;
  effectiveDate?: string | null;
  premium?: number | null;
  commissionPct?: number | null;
  status?: string | null;
}
export interface ProfitabilityAmounts {
  grossCommissionCents: number | null;
  producerShareCents: number | null;
  netRevenueCents: number | null;
  salaryCents: number | null;
  contributionCents: number | null;
}
export interface ProfitabilityRow extends ProfitabilityAmounts {
  userId: string | null;
  name: string;
  policyCount: number;
  missingCommissionCount: number;
  /** Policies without a compensation term on their effective date. */
  missingCompensationCount: number;
  knownGrossCommissionCents: number;
  knownProducerShareCents: number;
  knownNetRevenueCents: number;
  complete: boolean;
  warnings: string[];
}
export interface ProfitabilityTotals extends ProfitabilityAmounts {
  policyCount: number;
  missingCommissionCount: number;
  missingCompensationCount: number;
  incompleteEmployeeCount: number;
  knownGrossCommissionCents: number;
  knownProducerShareCents: number;
  knownNetRevenueCents: number;
  /** Sum only rows with a complete salary/contribution calculation. */
  knownSalaryCents: number;
  knownContributionCents: number;
  complete: boolean;
}
export interface EmployeeProfitabilityInput {
  from: string;
  to: string;
  employees: readonly ProfitabilityEmployee[];
  policies: readonly ProfitabilityPolicy[];
  assignments: Readonly<Record<string, { salespersonId?: string | null }>>;
  compensations: Readonly<Record<string, EmployeeCompensation>>;
}
export interface EmployeeProfitabilityResult {
  from: string;
  to: string;
  rows: ProfitabilityRow[];
  totals: ProfitabilityTotals;
  cancelledPolicyCount: number;
  undatedPolicyCount: number;
  warnings: string[];
}

const DAY = 86_400_000;
const SALARY_DENOMINATOR = 365n * 366n;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const validId = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value === value.trim() && value.length <= 200;
export function isProfitabilityDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01') return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
const day = (value: string) => Date.parse(`${value}T00:00:00.000Z`) / DAY;
const isoDay = (value: number) => new Date(value * DAY).toISOString().slice(0, 10);
export function validateProfitabilityWindow(from: unknown, to: unknown): { from: string; to: string } {
  if (!isProfitabilityDate(from) || !isProfitabilityDate(to) || from > to) throw new Error('Choose a valid start and end date.');
  if (day(to) - day(from) + 1 > 1831) throw new Error('Choose a reporting period of five years or less.');
  return { from, to };
}

/** Reject ambiguous histories rather than silently choosing an overlapping rate. */
export function validateCompensationRecord(value: unknown, expectedUserId?: string): EmployeeCompensation {
  if (!record(value) || !validId(value.userId) || expectedUserId != null && value.userId !== expectedUserId ||
    !Number.isSafeInteger(value.version) || (value.version as number) < 0 || !Array.isArray(value.terms) || value.terms.length > 100) {
    throw new Error('Invalid employee compensation record.');
  }
  const terms = value.terms.map((term): CompensationTerm => {
    if (!record(term) || !isProfitabilityDate(term.from) || term.to != null && (!isProfitabilityDate(term.to) || term.to < term.from) ||
      !Number.isSafeInteger(term.annualSalaryCents) || (term.annualSalaryCents as number) < 0 ||
      !Number.isSafeInteger(term.producerShareBps) || (term.producerShareBps as number) < 0 || (term.producerShareBps as number) > 10000) {
      throw new Error('Enter valid compensation dates, annual salary, and commission share.');
    }
    return { from: term.from, ...(term.to != null ? { to: term.to as string } : {}),
      annualSalaryCents: term.annualSalaryCents as number, producerShareBps: term.producerShareBps as number };
  }).sort((a, b) => a.from.localeCompare(b.from));
  for (let i = 1; i < terms.length; i++) {
    if (!terms[i - 1].to || terms[i].from <= terms[i - 1].to!) throw new Error('Compensation date ranges cannot overlap.');
  }
  return { userId: value.userId, version: value.version as number, terms };
}

function safe(value: bigint): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount)) throw new Error('The report amount is too large to calculate accurately.');
  return amount;
}
const roundedRatio = (numerator: bigint, denominator: bigint) => safe((numerator + denominator / 2n) / denominator);
const add = (left: number, right: number) => safe(BigInt(left) + BigInt(right));
function policyCommissionCents(policy: ProfitabilityPolicy): number | null {
  const { premium, commissionPct } = policy;
  if (typeof premium !== 'number' || !Number.isFinite(premium) || premium < 0 ||
    typeof commissionPct !== 'number' || !Number.isFinite(commissionPct) || commissionPct < 0 || commissionPct > 100) return null;
  const premiumCents = Math.round((premium + Number.EPSILON * Math.abs(premium)) * 100);
  if (!Number.isSafeInteger(premiumCents)) return null;
  const commission = Math.round(premiumCents * commissionPct / 100);
  return Number.isSafeInteger(commission) ? commission : null;
}
function salaryFor(terms: readonly CompensationTerm[], from: string, to: string): { cents: number | null; gap: boolean } {
  if (!terms.length) return { cents: null, gap: false };
  // Before the first term and after the last closed term are outside employment.
  // An internal hole could be missing pay data; only an explicit zero term means unpaid.
  for (let i = 1; i < terms.length; i++) {
    const gapFrom = day(terms[i - 1].to!) + 1, gapTo = day(terms[i].from) - 1;
    if (gapFrom <= gapTo && gapFrom <= day(to) && gapTo >= day(from)) return { cents: null, gap: true };
  }
  let numerator = 0n;
  for (const term of terms) {
    let start = day(term.from > from ? term.from : from);
    const end = day(term.to && term.to < to ? term.to : to);
    while (start <= end) {
      const year = Number(isoDay(start).slice(0, 4));
      const yearStart = Date.UTC(year, 0, 1) / DAY, nextYear = Date.UTC(year + 1, 0, 1) / DAY;
      const days = Math.min(end, nextYear - 1) - start + 1;
      numerator += BigInt(term.annualSalaryCents) * BigInt(days) * (SALARY_DENOMINATOR / BigInt(nextYear - yearStart));
      start += days;
    }
  }
  return { cents: roundedRatio(numerator, SALARY_DENOMINATOR), gap: false };
}

/** Estimated insurance contribution, not cash receipts or accounting net profit.
 * Revenue follows effective dates and the CURRENT account salesperson. */
export function calculateEmployeeProfitability(input: EmployeeProfitabilityInput): EmployeeProfitabilityResult {
  const { from, to } = validateProfitabilityWindow(input.from, input.to);
  const compensation = new Map(Object.entries(input.compensations).map(([id, value]) => [id, validateCompensationRecord(value, id)]));
  const names = new Map<string, string>();
  for (const employee of input.employees) {
    if (!validId(employee.userId) || typeof employee.name !== 'string' || !employee.name.trim()) throw new Error('Employee names are incomplete.');
    names.set(employee.userId, employee.name.trim());
  }
  const ids = new Set([...names.keys(), ...compensation.keys()]);
  const rows = new Map<string | null, ProfitabilityRow>();
  const rowFor = (userId: string | null) => {
    let row = rows.get(userId);
    if (!row) {
      const terms = userId ? compensation.get(userId)?.terms ?? [] : [];
      const salary = userId ? salaryFor(terms, from, to) : { cents: null, gap: false };
      row = { userId, name: userId ? names.get(userId) ?? `Unavailable teammate (${userId.slice(-8)})` : 'Unassigned',
        grossCommissionCents: 0, producerShareCents: userId && terms.length ? 0 : null,
        netRevenueCents: userId && terms.length ? 0 : null, salaryCents: salary.cents, contributionCents: null,
        policyCount: 0, missingCommissionCount: 0, missingCompensationCount: 0,
        knownGrossCommissionCents: 0, knownProducerShareCents: 0, knownNetRevenueCents: 0, complete: false,
        warnings: !userId ? ['Assign these policies to an employee to calculate their contribution.'] : !terms.length ? ['Compensation is not configured.'] : salary.gap ? ['Salary history has a gap during this period.'] : [] };
      rows.set(userId, row);
    }
    return row;
  };
  for (const id of ids) rowFor(id);
  let cancelledPolicyCount = 0, undatedPolicyCount = 0, undatedCancelledPolicyCount = 0;
  const undatedByEmployee = new Map<string | null, number>();
  const seen = new Set<string>();
  for (const policy of input.policies) {
    if (!validId(policy.id) || seen.has(policy.id)) throw new Error('Policy data contains a missing or duplicate policy ID.');
    seen.add(policy.id);
    const dated = isProfitabilityDate(policy.effectiveDate);
    // Cancellation is excluded regardless of whether its effective date was
    // recorded. It must not make an otherwise complete revenue estimate unknown.
    if (policy.status === 'CANCELLED') {
      if (!dated) undatedCancelledPolicyCount++;
      else if (policy.effectiveDate! >= from && policy.effectiveDate! <= to) cancelledPolicyCount++;
      continue;
    }
    if (!dated) {
      undatedPolicyCount++;
      const row = rowFor(input.assignments[policy.accountId]?.salespersonId || null);
      undatedByEmployee.set(row.userId, (undatedByEmployee.get(row.userId) ?? 0) + 1);
      continue;
    }
    // The predicate was evaluated above to handle excluded cancellations first.
    if (!policy.effectiveDate) continue;
    if (policy.effectiveDate < from || policy.effectiveDate > to) continue;
    const id = input.assignments[policy.accountId]?.salespersonId || null;
    const row = rowFor(id), gross = policyCommissionCents(policy);
    const term = id ? compensation.get(id)?.terms.find(value => value.from <= policy.effectiveDate! && (!value.to || value.to >= policy.effectiveDate!)) : undefined;
    row.policyCount++;
    if (gross == null) row.missingCommissionCount++;
    else row.knownGrossCommissionCents = add(row.knownGrossCommissionCents, gross);
    if (!term) row.missingCompensationCount++;
    if (gross != null && term) {
      const share = roundedRatio(BigInt(gross) * BigInt(term.producerShareBps), 10000n);
      row.knownProducerShareCents = add(row.knownProducerShareCents, share);
      row.knownNetRevenueCents = add(row.knownNetRevenueCents, gross - share);
    }
  }
  for (const row of rows.values()) {
    const undated = undatedByEmployee.get(row.userId) ?? 0;
    row.grossCommissionCents = row.missingCommissionCount || undated ? null : row.knownGrossCommissionCents;
    const shareKnown = row.producerShareCents != null && !row.missingCommissionCount && !row.missingCompensationCount && !undated;
    row.producerShareCents = shareKnown ? row.knownProducerShareCents : null;
    row.netRevenueCents = shareKnown ? row.knownNetRevenueCents : null;
    row.contributionCents = row.netRevenueCents != null && row.salaryCents != null ? add(row.netRevenueCents, -row.salaryCents) : null;
    if (row.missingCommissionCount) row.warnings.push(`${row.missingCommissionCount} policies have missing or invalid commission amounts.`);
    if (row.missingCompensationCount && row.userId) row.warnings.push(`${row.missingCompensationCount} policies have no commission share for their effective date.`);
    if (undated) row.warnings.push(`${undated} policies have no valid effective date; this employee's revenue cannot be completed for the period.`);
    row.complete = row.contributionCents != null;
  }
  const sortedRows = [...rows.values()].sort((a, b) => a.userId == null ? 1 : b.userId == null ? -1 : a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId));
  const sum = (field: keyof ProfitabilityRow) => sortedRows.reduce((total, row) => add(total, typeof row[field] === 'number' ? row[field] as number : 0), 0);
  const completeAmount = (field: keyof ProfitabilityAmounts) => undatedPolicyCount || sortedRows.some(row => row[field] == null) ? null : sum(field);
  const warnings = [];
  if (undatedPolicyCount) warnings.push(`${undatedPolicyCount} policies have no valid effective date and cannot be placed in this period.`);
  if (cancelledPolicyCount) warnings.push(`${cancelledPolicyCount} cancelled policies are excluded; cancellation adjustments are not recorded in this estimate.`);
  if (undatedCancelledPolicyCount) warnings.push(`${undatedCancelledPolicyCount} cancelled policies with no valid effective date are also excluded.`);
  return { from, to, rows: sortedRows, cancelledPolicyCount, undatedPolicyCount, warnings,
    totals: { grossCommissionCents: completeAmount('grossCommissionCents'), producerShareCents: completeAmount('producerShareCents'),
      netRevenueCents: completeAmount('netRevenueCents'), salaryCents: sortedRows.some(row => row.salaryCents == null) ? null : sum('salaryCents'),
      contributionCents: completeAmount('contributionCents'), policyCount: sum('policyCount'), missingCommissionCount: sum('missingCommissionCount'),
      missingCompensationCount: sum('missingCompensationCount'), incompleteEmployeeCount: sortedRows.filter(row => row.userId && !row.complete).length,
      knownGrossCommissionCents: sum('knownGrossCommissionCents'), knownProducerShareCents: sum('knownProducerShareCents'),
      knownNetRevenueCents: sum('knownNetRevenueCents'), knownSalaryCents: sum('salaryCents'), knownContributionCents: sum('contributionCents'),
      complete: !undatedPolicyCount && sortedRows.every(row => row.complete) } };
}
