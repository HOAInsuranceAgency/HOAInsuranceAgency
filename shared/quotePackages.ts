import { authorizedQuoteTerms } from './quoteAuthorization';
import { validCalendarDate } from './renewalPolicy';

export interface PackageQuote {
  id: string;
  accountId: string;
  status: string;
  carrierId?: string | null;
  lines?: (string | null)[] | null;
  premium?: number | null;
  commissionPct?: number | null;
  effectiveDate?: string | null;
  expirationDate?: string | null;
  offerExpiresAt?: string | null;
  renewalPolicyId?: string | null;
}
export interface PackageOption {
  id: string;
  name: string;
  quoteIds: string[];
  reviewed?: { at: string; by: string; terms: Record<string, string> };
}
export interface CommercialPlan {
  accountId: string;
  version: number;
  estimatedCents: number | null;
  requiredLines: string[];
  options: PackageOption[];
  selectedOptionId: string | null;
  selectedTerms?: Record<string, string>;
  selectedAt?: string;
}
export const formatCommission = (cents: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: cents % 100 ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(cents / 100);
export const emptyCommercialPlan = (accountId: string): CommercialPlan => ({
  accountId,
  version: 0,
  estimatedCents: null,
  requiredLines: [],
  options: [],
  selectedOptionId: null,
});
export const packageTerms = (quote: PackageQuote) =>
  JSON.stringify({
    terms: authorizedQuoteTerms(quote as unknown as Record<string, unknown>),
    commissionPct: quote.commissionPct ?? null,
    offerExpiresAt: quote.offerExpiresAt ?? null,
    renewalPolicyId: quote.renewalPolicyId ?? null,
    notes: (quote as PackageQuote & { notes?: string | null }).notes ?? null,
  });
export const commissionCents = (q: PackageQuote): number | null => {
  if (
    q.premium == null ||
    !Number.isFinite(q.premium) ||
    q.premium <= 0 ||
    !Number.isSafeInteger(Math.round(q.premium * 100)) ||
    q.commissionPct == null ||
    !Number.isFinite(q.commissionPct) ||
    q.commissionPct < 0 ||
    q.commissionPct > 100
  )
    return null;
  const cents = Math.round(q.premium * q.commissionPct);
  return Number.isSafeInteger(cents) ? cents : null;
};
const linesOf = (lines: (string | null)[] | null | undefined) => [
  ...new Set(
    (lines ?? [])
      .filter((v): v is string => !!v)
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
  ),
];
export function packageAssessment(
  plan: CommercialPlan,
  option: PackageOption,
  quotes: PackageQuote[],
  today: string,
  requireReview = true,
) {
  const selected = option.quoteIds.map((id) =>
    quotes.find((q) => q.id === id && q.accountId === plan.accountId),
  );
  const problems: string[] = [];
  if (!plan.requiredLines.length) problems.push('Choose the coverages needed');
  if (!selected.length) problems.push('Choose quotes for this option');
  if (new Set(option.quoteIds).size !== option.quoteIds.length)
    problems.push('A quote can only be counted once');
  if (selected.some((q) => !q)) problems.push('A quote is missing');
  const valid = selected.filter((q): q is PackageQuote => !!q);
  if (valid.some((q) => !['QUOTED', 'PRESENTED', 'BOUND'].includes(q.status)))
    problems.push('An offer is not ready or has been withdrawn');
  if (
    valid.some(
      (q) =>
        q.status !== 'BOUND' &&
        q.offerExpiresAt &&
        (!validCalendarDate(q.offerExpiresAt) || q.offerExpiresAt < today),
    )
  )
    problems.push('An offer has expired or has an invalid expiration');
  if (
    valid.some(
      (q) =>
        !q.carrierId ||
        !validCalendarDate(q.effectiveDate) ||
        !validCalendarDate(q.expirationDate) ||
        q.expirationDate <= q.effectiveDate ||
        q.expirationDate <= today,
    )
  )
    problems.push('Check the carrier and policy term');
  if (
    new Set(valid.map((q) => `${q.effectiveDate}/${q.expirationDate}`)).size > 1
  )
    problems.push('The policy terms do not match');
  if (valid.some((q) => q.renewalPolicyId))
    problems.push('Renewal quotes belong in renewal work');
  const included = new Set(valid.flatMap((q) => linesOf(q.lines)));
  const missing = plan.requiredLines.filter(
    (line) => !included.has(line.trim().toLowerCase()),
  );
  if (missing.length) problems.push(`Missing ${missing.join(', ')}`);
  if (valid.some((q) => !linesOf(q.lines).length))
    problems.push('Record each quote’s coverages');
  if (valid.some((q) => commissionCents(q) == null))
    problems.push('Commission information is missing');
  if (
    !Number.isSafeInteger(
      valid.reduce((sum, q) => sum + Math.round((q.premium ?? 0) * 100), 0),
    ) ||
    !Number.isSafeInteger(
      valid.reduce((sum, q) => sum + (commissionCents(q) ?? 0), 0),
    )
  )
    problems.push('Check the recorded amounts');
  if (
    requireReview &&
    (!option.reviewed ||
      valid.some((q) => option.reviewed?.terms[q.id] !== packageTerms(q)))
  )
    problems.push('Review this package’s current terms');
  const boundCount = valid.filter((q) => q.status === 'BOUND').length;
  return {
    problems: [...new Set(problems)],
    complete: problems.length === 0,
    premiumCents: valid.reduce(
      (sum, q) => sum + Math.round((q.premium ?? 0) * 100),
      0,
    ),
    commissionCents: valid.reduce(
      (sum, q) => sum + (commissionCents(q) ?? 0),
      0,
    ),
    pendingCents: valid
      .filter((q) => q.status !== 'BOUND')
      .reduce((sum, q) => sum + (commissionCents(q) ?? 0), 0),
    boundCount,
    quoteCount: option.quoteIds.length,
    // Overlap can be legitimate (layers / different limits). It requires the
    // same explicit compatibility review as any package, never automatic splitting.
    overlaps: [...included].filter(
      (line) => valid.filter((q) => linesOf(q.lines).includes(line)).length > 1,
    ),
  };
}
export function pendingCommission(
  plan: CommercialPlan,
  quotes: PackageQuote[],
  today: string,
) {
  const options = plan.options.map((option) => ({
    option,
    ...packageAssessment(plan, option, quotes, today),
  }));
  const selected = options.find((o) => o.option.id === plan.selectedOptionId);
  if (plan.selectedOptionId) {
    const currentSelection =
      selected &&
      Object.keys(plan.selectedTerms ?? {}).length ===
        selected.option.quoteIds.length &&
      selected.option.quoteIds.every((id) => {
        const q = quotes.find((q) => q.id === id);
        return q && plan.selectedTerms?.[id] === packageTerms(q);
      });
    return {
      cents:
        selected?.complete && currentSelection ? selected.pendingCents : null,
      label:
        !selected?.complete || !currentSelection
          ? 'Selected package needs review'
          : selected.boundCount === selected.quoteCount
            ? 'Fully bound'
            : selected.boundCount
              ? 'Partially bound'
              : 'Client-selected package',
      optionId: selected?.option.id,
      unfinished: !!selected && selected.boundCount < selected.quoteCount,
    };
  }
  const ready = options
    .filter((o) => o.complete && o.boundCount === 0)
    .sort(
      (a, b) =>
        a.commissionCents - b.commissionCents ||
        a.option.id.localeCompare(b.option.id),
    );
  return {
    cents: ready[0]?.commissionCents ?? null,
    label: ready.length
      ? 'Lowest complete package'
      : plan.options.length
        ? 'Incomplete package'
        : 'No package options',
    optionId: ready[0]?.option.id,
    unfinished: false,
  };
}
export function parseEstimate(value: unknown): number | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{1,9}(\.\d{1,2})?$/.test(value))
    throw new Error('Enter a dollar amount with up to two decimal places');
  const [whole, fraction = ''] = value.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
export function alternativeQuoteIds(plan?: CommercialPlan | null): string[] {
  const selected = plan?.options.find((o) => o.id === plan.selectedOptionId);
  return selected
    ? [...new Set(plan!.options.flatMap((o) => o.quoteIds))].filter(
        (id) => !selected.quoteIds.includes(id),
      )
    : [];
}
