import { day, type CommissionAccount } from '../../../../shared/commissions';

export function bindDay(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return day(value);
  if (!Number.isFinite(Date.parse(value))) return undefined;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value));
}
/** Owner-attested history includes business predating the CRM. Never infer that
 * an old account is new merely because its imported policy dates are missing. */
export function firstBindDate(
  account: CommissionAccount | undefined,
  boundOn: string,
  hasPolicies: boolean,
  earliestKnown?: string,
) {
  if (account?.firstBoundOn) {
    const first = day(account.firstBoundOn);
    if (first > boundOn || (earliestKnown && first > earliestKnown))
      throw new Error(
        'The account’s original first bind date is later than a known policy bind. An Owner must correct its first-bind history.',
      );
    return first;
  }
  if (account?.neverBound) {
    if (hasPolicies)
      throw new Error(
        'This account already has policy history. An Owner must confirm its original first bind date before continuing.',
      );
    return boundOn;
  }
  return undefined;
}
