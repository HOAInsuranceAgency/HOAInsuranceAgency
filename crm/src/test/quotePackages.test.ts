import { describe, expect, it } from 'vitest';
import {
  formatCommission,
  emptyCommercialPlan,
  packageAssessment,
  packageTerms,
  pendingCommission,
  parseEstimate,
  alternativeQuoteIds,
  type CommercialPlan,
  type PackageQuote,
} from '../../../shared/quotePackages';
import { websiteFormLabel } from '../../../shared/leadSource';
const today = '2026-09-14';
const quote = (
  id: string,
  lines: string[],
  commission: number,
): PackageQuote => ({
  id,
  accountId: 'a',
  carrierId: id,
  status: 'QUOTED',
  lines,
  premium: commission * 10,
  commissionPct: 10,
  effectiveDate: '2026-10-01',
  expirationDate: '2027-10-01',
  offerExpiresAt: '2026-09-30',
});
const quotes = [
  quote('bundle', ['Property', 'D&O'], 1500),
  quote('property', ['Property'], 1100),
  quote('do', ['D&O'], 250),
];
function plan(): CommercialPlan {
  return {
    ...emptyCommercialPlan('a'),
    estimatedCents: 200000,
    requiredLines: ['Property', 'D&O'],
    options: [['bundle'], ['property', 'do']].map((ids, i) => ({
      id: `option${i}`,
      name: `Option ${i}`,
      quoteIds: ids,
      reviewed: {
        at: today,
        by: 'champion',
        terms: Object.fromEntries(
          ids.map((id) => [id, packageTerms(quotes.find((q) => q.id === id)!)]),
        ),
      },
    })),
  };
}
describe('complete package commissions', () => {
  it('compares the whole bundle with the combined standalone quotes, without counting all alternatives', () => {
    expect(pendingCommission(plan(), quotes, today)).toMatchObject({
      cents: 135000,
      optionId: 'option1',
    });
    expect(plan().estimatedCents).toBe(200000);
  });
  it('uses the bundle when that complete option earns less', () => {
    const qs = quotes.map((q) =>
        q.id === 'bundle' ? { ...q, premium: 10000 } : q,
      ),
      p = plan();
    p.options[0].reviewed!.terms.bundle = packageTerms(qs[0]);
    expect(pendingCommission(p, qs, today).cents).toBe(100000);
  });
  it('does not treat one cheap line as the complete account opportunity', () => {
    const p = plan();
    p.options = [{ ...p.options[1], quoteIds: ['do'] }];
    expect(pendingCommission(p, quotes, today)).toMatchObject({
      cents: null,
      label: 'Incomplete package',
    });
  });
  it.each(['DRAFT', 'SUBMITTED', 'DECLINED', 'LOST'])(
    'excludes %s quotes',
    (status) => {
      const p = plan();
      p.options = [p.options[1]];
      expect(
        pendingCommission(
          p,
          quotes.map((q) => (q.id === 'property' ? { ...q, status } : q)),
          today,
        ).cents,
      ).toBeNull();
    },
  );
  it('excludes expired offers, missing rates, deleted quotes and changed terms', () => {
    const p = plan();
    p.options = [p.options[1]];
    for (const patch of [
      { offerExpiresAt: '2026-09-13' },
      { commissionPct: null },
      { premium: 12000 },
      { effectiveDate: '2026-11-01' },
      { expirationDate: 'invalid' },
      { accountId: 'other' },
    ])
      expect(
        pendingCommission(
          p,
          quotes.map((q) => (q.id === 'property' ? { ...q, ...patch } : q)),
          today,
        ).cents,
      ).toBeNull();
    expect(
      pendingCommission(
        p,
        quotes.filter((q) => q.id !== 'do'),
        today,
      ).cents,
    ).toBeNull();
  });
  it('requires actual compatibility review, including overlapping lines', () => {
    const p = plan(),
      option = {
        id: 'overlap',
        name: 'Layers',
        quoteIds: ['bundle', 'property'],
      };
    expect(packageAssessment(p, option, quotes, today)).toMatchObject({
      complete: false,
      overlaps: ['property'],
    });
    expect(packageAssessment(p, option, quotes, today, false).complete).toBe(
      true,
    );
  });
  it('rejects duplicate inclusion of the same quote', () => {
    const p = plan();
    expect(
      packageAssessment(
        p,
        { ...p.options[0], quoteIds: ['bundle', 'bundle'] },
        quotes,
        today,
      ).complete,
    ).toBe(false);
  });
  it('uses the client-selected package even if another option is cheaper', () => {
    const p = plan();
    p.selectedOptionId = 'option0';
    p.selectedTerms = p.options[0].reviewed!.terms;
    expect(pendingCommission(p, quotes, today)).toMatchObject({
      cents: 150000,
      label: 'Client-selected package',
    });
    expect(alternativeQuoteIds(p)).toEqual(['property', 'do']);
  });
  it('retains partial binding and only counts commission still pending', () => {
    const p = plan();
    p.selectedOptionId = 'option1';
    p.selectedTerms = p.options[1].reviewed!.terms;
    expect(
      pendingCommission(
        p,
        quotes.map((q) =>
          q.id === 'property' ? { ...q, status: 'BOUND' } : q,
        ),
        today,
      ),
    ).toMatchObject({
      cents: 25000,
      unfinished: true,
      label: 'Partially bound',
    });
    expect(
      pendingCommission(
        p,
        quotes.map((q) => ({ ...q, status: 'BOUND' })),
        today,
      ),
    ).toMatchObject({ cents: 0, unfinished: false, label: 'Fully bound' });
  });
  it('does not switch away from a selected package whose remaining quote goes missing', () => {
    const p = plan();
    p.selectedOptionId = 'option1';
    p.selectedTerms = p.options[1].reviewed!.terms;
    expect(
      pendingCommission(
        p,
        quotes.filter((q) => q.id !== 'do'),
        today,
      ),
    ).toMatchObject({
      cents: null,
      unfinished: true,
      label: 'Selected package needs review',
    });
  });
  it('requires renewed client selection after reviewed terms change', () => {
    const p = plan();
    p.selectedOptionId = 'option1';
    p.selectedTerms = { ...p.options[1].reviewed!.terms };
    const qs = quotes.map((q) =>
      q.id === 'property' ? { ...q, premium: 13000 } : q,
    );
    p.options[1].reviewed!.terms.property = packageTerms(qs[1]);
    expect(pendingCommission(p, qs, today)).toMatchObject({
      cents: null,
      unfinished: true,
    });
  });
  it('treats a recorded zero commission as zero, not unknown', () => {
    const p = plan(),
      qs = quotes.map((q) => ({ ...q, commissionPct: 0 }));
    p.options[0].reviewed!.terms.bundle = packageTerms(qs[0]);
    expect(pendingCommission(p, qs, today).cents).toBe(0);
  });
});
describe('manual estimates and form names', () => {
  it('preserves cents in amounts shown to staff', () => {
    expect(formatCommission(125050)).toBe('$1,250.50');
    expect(formatCommission(0)).toBe('$0');
  });
  it('stores dollars exactly as cents and distinguishes blank from zero', () => {
    expect(parseEstimate('1234.56')).toBe(123456);
    expect(parseEstimate('0')).toBe(0);
    expect(parseEstimate('')).toBeNull();
  });
  it.each(['-1', 'NaN', 'Infinity', '1.001', '1e3', 42])(
    'rejects invalid amount %s',
    (value) => expect(() => parseEstimate(value)).toThrow(),
  );
  it('shows friendly forms without inventing missing historical attribution', () => {
    expect(websiteFormLabel('website-ho6:willow-court')).toBe(
      'Association / HO-6 form',
    );
    expect(websiteFormLabel('website-assessment:home')).toBe(
      'Instant assessment',
    );
    expect(websiteFormLabel('website')).toBe('Not recorded');
  });
});
