import { describe, expect, it } from 'vitest';
import { agencyDay } from '../../../shared/agencyTime';
import { formatUsdCents, formatUsdDollars } from '../../../shared/money';
import { isUSStateCode, US_STATES, US_STATE_CATALOG, US_STATE_NAMES, usStateCode } from '../../../shared/usStates';
import { formatMoney } from '../../../shared/invoiceTotals';
import { formatCommission } from '../../../shared/quotePackages';
import { dueToday } from '../../../shared/leadWorkViews';
import { businessDate } from '../../../shared/honeycomb/submission';
import { usableQuote } from '../../../shared/renewalPolicy';
import { bindDay } from '../../amplify/functions/commissions/account-history';
import { states, reviewedStateSlugs } from '../../../web/src/data/states';
import { accountStateCode } from './accountListView';

// Prior recipes check equivalence, including Intl rounding that decimal arithmetic changes.
const amounts = [0, -0, 0.005, -0.005, 0.995, -0.995, 1.005, -1.005, 1.995, -1.995,
  12480.01, 12480.5, -12480.5, 999999999.995, Number.MAX_SAFE_INTEGER, NaN, Infinity, -Infinity];

describe('explicit-unit USD presentation', () => {
  it('distinguishes cents, dollars, summary rounding and optional decimals', () => {
    expect(formatUsdCents(12345)).toBe('$123.45');
    expect(formatUsdDollars(12345)).toBe('$12,345.00');
    expect(formatUsdCents(12345, 'whole')).toBe('$123');
    expect(formatUsdCents(12300, 'optionalCents')).toBe('$123');
    expect(formatUsdCents(12345, 'optionalCents')).toBe('$123.45');
    expect(formatUsdDollars(-0.005)).toBe('-$0.01');
    expect(formatUsdDollars(1.995)).toBe('$2.00');
  });
  it.each(amounts)('preserves native currency formatting for %s', value => {
    const exact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
    const whole = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
    expect(formatUsdDollars(value)).toBe(exact.format(value));
    expect(formatUsdDollars(value, 'whole')).toBe(whole.format(value));
    expect(formatUsdCents(value)).toBe(exact.format(value / 100));
    const commission = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: value % 100 ? 2 : 0, maximumFractionDigits: 2 });
    expect(formatCommission(value)).toBe(commission.format(value / 100));
  });
  it('leaves invoice fallback policy separate from the formatting primitive', () => {
    for (const value of [null, undefined, NaN, Infinity, -Infinity]) expect(formatMoney(value)).toBe('$0.00');
    expect(formatMoney(-0)).toBe('-$0.00');
    expect(formatMoney(-1000.005)).toBe('-$1,000.01');
    expect(formatUsdDollars(NaN)).toBe('$NaN');
    expect(formatUsdCents(Infinity)).toBe('$∞');
  });
});

describe('agency instant-to-calendar-day presentation', () => {
  it.each([
    ['2026-01-01T04:59:59.999Z', '2025-12-31'], ['2026-01-01T05:00:00Z', '2026-01-01'],
    ['2026-07-01T03:59:59.999Z', '2026-06-30'], ['2026-07-01T04:00:00Z', '2026-07-01'],
    ['2026-03-08T06:59:59Z', '2026-03-08'], ['2026-03-08T07:00:00Z', '2026-03-08'],
    ['2026-11-01T05:59:59Z', '2026-11-01'], ['2026-11-01T06:00:00Z', '2026-11-01'],
    ['2024-03-01T04:30:00Z', '2024-02-29'], ['2026-07-01T00:30:00+09:00', '2026-06-30'],
  ])('uses New York for %s', (instant, day) => {
    const date = new Date(instant), time = date.getTime();
    expect(agencyDay(instant)).toBe(day);
    expect(agencyDay(date)).toBe(day);
    expect(agencyDay(time)).toBe(day);
    expect(date.getTime()).toBe(time);
    expect(businessDate(date)).toBe(day);
    expect(bindDay(instant)).toBe(day);
  });
  it('preserves domain-specific date-only and invalid-date handling', () => {
    expect(agencyDay('2026-07-01')).toBe('2026-06-30');
    expect(bindDay('2026-07-01')).toBe('2026-07-01');
    expect(bindDay('invalid')).toBeUndefined();
    expect(bindDay(null)).toBeUndefined();
    expect(() => agencyDay('invalid')).toThrow(RangeError);
    expect(dueToday('invalid', '2026-07-01T04:00:00Z')).toBe(false);
    expect(dueToday('2026-07-01T03:59:59Z', '2026-07-01T04:00:00Z')).toBe(false);
    const risk = { accountId: 'fictional-account', term: '2026-07-01', lines: ['Property'] };
    const quote = { accountId: risk.accountId, carrierId: 'fictional-carrier', status: 'QUOTED', lines: risk.lines, effectiveDate: risk.term, expirationDate: '2027-07-01', premium: 100, offerExpiresAt: '2026-06-30' };
    expect(usableQuote(quote, risk, '2026-07-01')).toBe(false);
    expect(usableQuote(quote, risk, '2026-07-01T03:59:59Z')).toBe(true);
  });
});

describe('shared state/DC identity catalog', () => {
  it('keeps stable CRM order, map order, names, uniqueness and immutable reference data', () => {
    expect(US_STATES.join(' ')).toBe('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC');
    expect(Object.keys(US_STATE_NAMES)).toEqual([...US_STATES].sort());
    expect(new Set(US_STATE_CATALOG.map(state => state.name)).size).toBe(51);
    expect(new Set(US_STATES).size).toBe(51);
    expect(US_STATE_NAMES.DC).toBe('District of Columbia');
    expect(Object.isFrozen(US_STATE_CATALOG)).toBe(true);
    expect(US_STATE_CATALOG.every(Object.isFrozen)).toBe(true);
    for (const state of US_STATE_CATALOG) {
      expect(isUSStateCode(state.code)).toBe(true);
      expect(usStateCode(state.name)).toBe(state.code);
      expect(accountStateCode(` ${state.name.toLowerCase()} `)).toBe(state.code);
    }
  });
  it('keeps normalization separate from strict jurisdiction membership', () => {
    for (const input of [' ma ', 'massachusetts', ' MASSACHUSETTS ']) expect(usStateCode(input)).toBe('MA');
    for (const input of ['ma', ' MA ', 'Massachusetts', 'PR', '', null, undefined, 25]) expect(isUSStateCode(input)).toBe(false);
    for (const input of ['PR', 'Unknown', '', null, undefined]) expect(usStateCode(input)).toBe('');
  });
  it('keeps reviewed route order and pending identities without promoting editorial status', () => {
    expect(reviewedStateSlugs).toEqual(['massachusetts', 'rhode-island', 'new-hampshire', 'connecticut', 'new-york', 'oklahoma']);
    expect(states.slice(0, 6).map(state => state.abbr)).toEqual(['MA', 'RI', 'NH', 'CT', 'NY', 'OK']);
    expect(states.filter(state => state.reviewed)).toHaveLength(6);
    expect(states).toHaveLength(51);
    expect(new Set(states.map(state => state.slug)).size).toBe(51);
    const pending = states.slice(6);
    expect(pending.map(state => state.name)).toEqual(pending.map(state => state.name).sort((a, b) => a.localeCompare(b)));
    for (const state of states) {
      expect(state.name).toBe(US_STATE_NAMES[state.abbr]);
      expect(state.slug).toBe(state.name.toLowerCase().replaceAll(' ', '-'));
    }
  });
});
