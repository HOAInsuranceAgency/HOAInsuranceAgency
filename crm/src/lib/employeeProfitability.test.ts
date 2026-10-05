import { describe, expect, it } from 'vitest';
import {
  calculateEmployeeProfitability, validateCompensationRecord, validateProfitabilityWindow,
  type CompensationTerm, type EmployeeCompensation, type EmployeeProfitabilityInput,
} from '../../../shared/employeeProfitability';

const term = (overrides: Partial<CompensationTerm> = {}): CompensationTerm => ({
  from: '2026-01-01', annualSalaryCents: 3_650_000, producerShareBps: 2500, ...overrides,
});
const pay = (terms = [term()], userId = 'producer'): EmployeeCompensation => ({ userId, version: 1, terms });
const base: EmployeeProfitabilityInput = {
  from: '2026-01-01', to: '2026-01-31',
  employees: [{ userId: 'producer', name: 'Avery' }],
  policies: [{ id: 'policy', accountId: 'account', premium: 10_000, commissionPct: 10, effectiveDate: '2026-01-15', status: 'ACTIVE' }],
  assignments: { account: { salespersonId: 'producer' } },
  compensations: { producer: pay() },
};

describe('employee profitability calculation', () => {
  it('compares retained agency commission with salary, never gross premium', () => {
    const result = calculateEmployeeProfitability(base);
    expect(result.rows[0]).toMatchObject({ grossCommissionCents: 100_000, producerShareCents: 25_000,
      netRevenueCents: 75_000, salaryCents: 310_000, contributionCents: -235_000, policyCount: 1, complete: true });
    expect(result.totals).toMatchObject({ grossCommissionCents: 100_000, contributionCents: -235_000, complete: true });
  });

  it('applies inclusive policy effective dates and excludes cancelled policies', () => {
    const result = calculateEmployeeProfitability({ ...base, policies: [
      { ...base.policies[0], id: 'start', effectiveDate: base.from },
      { ...base.policies[0], id: 'end', effectiveDate: base.to, status: 'EXPIRED' },
      { ...base.policies[0], id: 'past', effectiveDate: '2025-12-31' },
      { ...base.policies[0], id: 'future', effectiveDate: '2026-02-01' },
      { ...base.policies[0], id: 'cancelled', status: 'CANCELLED' },
    ] });
    expect(result.rows[0]).toMatchObject({ grossCommissionCents: 200_000, policyCount: 2 });
    expect(result.cancelledPolicyCount).toBe(1);
    expect(result.warnings.join(' ')).toContain('cancellation adjustments');
  });

  it('uses current assignments and retains historical owners outside the current roster', () => {
    const result = calculateEmployeeProfitability({ ...base, assignments: { account: { salespersonId: 'former' } },
      compensations: { ...base.compensations, former: pay([term({ to: '2026-01-31' })], 'former') } });
    expect(result.rows.find(row => row.userId === 'producer')).toMatchObject({ policyCount: 0, contributionCents: -310_000 });
    expect(result.rows.find(row => row.userId === 'former')).toMatchObject({ policyCount: 1, grossCommissionCents: 100_000, complete: true });
  });

  it('includes salaried staff with no accounts or policies', () => {
    const result = calculateEmployeeProfitability({ ...base, employees: [...base.employees, { userId: 'staff', name: 'Blake' }],
      compensations: { ...base.compensations, staff: pay([term({ producerShareBps: 0 })], 'staff') } });
    expect(result.rows.find(row => row.userId === 'staff')).toMatchObject({ policyCount: 0, grossCommissionCents: 0,
      producerShareCents: 0, salaryCents: 310_000, contributionCents: -310_000, complete: true });
    expect(result.totals.contributionCents).toBe(-545_000);
  });

  it('does not create rows from unrelated or out-of-period assignments', () => {
    const result = calculateEmployeeProfitability({ ...base, assignments: {
      ...base.assignments, old: { salespersonId: 'other-employee' }, unused: { salespersonId: 'unused-employee' },
    }, policies: [...base.policies, { ...base.policies[0], id: 'old', accountId: 'old', effectiveDate: '2025-12-31' }] });
    expect(result.rows.map(row => row.userId)).toEqual(['producer']);
  });

  it('rounds each policy commission and producer share to cents before accumulating', () => {
    const result = calculateEmployeeProfitability({ ...base, from: '2026-01-01', to: '2026-01-01',
      compensations: { producer: pay([term({ annualSalaryCents: 0, producerShareBps: 5000 })]) }, policies: [
        { ...base.policies[0], id: 'one', effectiveDate: base.from, premium: 1.05, commissionPct: 10 },
        { ...base.policies[0], id: 'two', effectiveDate: base.from, premium: 1.05, commissionPct: 10 },
      ] });
    expect(result.rows[0]).toMatchObject({ grossCommissionCents: 22, producerShareCents: 12, netRevenueCents: 10, contributionCents: 10 });
  });

  it('prorates salary over leap years and rate changes and rounds only after totaling the period', () => {
    const result = calculateEmployeeProfitability({ ...base, from: '2024-02-28', to: '2024-03-01', policies: [],
      compensations: { producer: pay([
        term({ from: '2024-01-01', to: '2024-02-28', annualSalaryCents: 366 }),
        term({ from: '2024-02-29', annualSalaryCents: 732 }),
      ]) } });
    expect(result.rows[0].salaryCents).toBe(5);
    const fraction = calculateEmployeeProfitability({ ...base, from: '2026-01-01', to: '2026-01-02', policies: [],
      compensations: { producer: pay([term({ annualSalaryCents: 100 })]) } });
    expect(fraction.rows[0].salaryCents).toBe(1);
  });

  it('pays exactly the annual salary for complete ordinary and leap years', () => {
    for (const year of [2024, 2026]) {
      const result = calculateEmployeeProfitability({ ...base, from: `${year}-01-01`, to: `${year}-12-31`, policies: [],
        compensations: { producer: pay([term({ from: '2020-01-01', annualSalaryCents: 6_700_123 })]) } });
      expect(result.rows[0].salaryCents).toBe(6_700_123);
    }
    const spanning = calculateEmployeeProfitability({ ...base, from: '2023-12-31', to: '2024-01-01', policies: [],
      compensations: { producer: pay([term({ from: '2020-01-01', annualSalaryCents: 3_660_000 })]) } });
    expect(spanning.rows[0].salaryCents).toBe(20_027);
  });

  it('honors employment start/end without treating dates outside employment as missing salary', () => {
    const result = calculateEmployeeProfitability({ ...base, policies: [], compensations: { producer: pay([
      term({ from: '2026-01-10', to: '2026-01-20' }),
    ]) } });
    expect(result.rows[0]).toMatchObject({ salaryCents: 110_000, contributionCents: -110_000, complete: true });
    const after = calculateEmployeeProfitability({ ...base, from: '2026-02-01', to: '2026-02-28', policies: [],
      compensations: { producer: pay([term({ to: '2026-01-31' })]) } });
    expect(after.rows[0]).toMatchObject({ salaryCents: 0, contributionCents: 0, complete: true });
  });

  it('treats a gap inside compensation history as unknown unless explicitly recorded as unpaid', () => {
    const history = [term({ to: '2026-01-10' }), term({ from: '2026-01-20' })];
    const gap = calculateEmployeeProfitability({ ...base, policies: [], compensations: { producer: pay(history) } });
    expect(gap.rows[0]).toMatchObject({ salaryCents: null, contributionCents: null, complete: false });
    expect(gap.rows[0].warnings.join(' ')).toContain('gap');
    const zero = calculateEmployeeProfitability({ ...base, policies: [], compensations: { producer: pay([
      ...history, term({ from: '2026-01-11', to: '2026-01-19', annualSalaryCents: 0 }),
    ]) } });
    expect(zero.rows[0]).toMatchObject({ salaryCents: 220_000, complete: true });
    const outside = calculateEmployeeProfitability({ ...base, from: '2026-02-01', to: '2026-02-28', policies: [],
      compensations: { producer: pay(history) } });
    expect(outside.rows[0]).toMatchObject({ salaryCents: 280_000, complete: true });
  });

  it('applies the split effective on the policy date, including closed rate boundaries', () => {
    const result = calculateEmployeeProfitability({ ...base, policies: [
      { ...base.policies[0], id: 'old', effectiveDate: '2026-01-15' },
      { ...base.policies[0], id: 'new', effectiveDate: '2026-01-16' },
    ], compensations: { producer: pay([term({ to: '2026-01-15', producerShareBps: 2000 }), term({ from: '2026-01-16', producerShareBps: 5000 })]) } });
    expect(result.rows[0]).toMatchObject({ grossCommissionCents: 200_000, producerShareCents: 70_000, netRevenueCents: 130_000 });
  });

  it('does not silently use zero salary or commission share when compensation is missing', () => {
    const cases: EmployeeProfitabilityInput['compensations'][] = [{}, { producer: pay([]) }];
    for (const compensations of cases) {
      const result = calculateEmployeeProfitability({ ...base, compensations });
      expect(result.rows[0]).toMatchObject({ grossCommissionCents: 100_000, producerShareCents: null, salaryCents: null,
        contributionCents: null, missingCompensationCount: 1, complete: false });
      expect(result.totals).toMatchObject({ grossCommissionCents: 100_000, contributionCents: null,
        knownGrossCommissionCents: 100_000, knownContributionCents: 0, incompleteEmployeeCount: 1, complete: false });
    }
  });

  it('flags policy revenue outside employment instead of giving the agency the full commission', () => {
    const result = calculateEmployeeProfitability({ ...base, compensations: { producer: pay([term({ from: '2026-01-16' })]) } });
    expect(result.rows[0]).toMatchObject({ salaryCents: 160_000, producerShareCents: null, netRevenueCents: null,
      missingCompensationCount: 1, contributionCents: null, complete: false });
  });

  it.each([null, undefined, -1, Infinity, NaN, 101])('keeps invalid commission percentage %s unknown', commissionPct => {
    const result = calculateEmployeeProfitability({ ...base, policies: [base.policies[0], { ...base.policies[0], id: 'missing', commissionPct }] });
    expect(result.rows[0]).toMatchObject({ grossCommissionCents: null, producerShareCents: null, contributionCents: null,
      missingCommissionCount: 1, knownGrossCommissionCents: 100_000, knownNetRevenueCents: 75_000 });
    expect(result.totals).toMatchObject({ grossCommissionCents: null, knownGrossCommissionCents: 100_000, complete: false });
  });

  it.each([null, undefined, -1, Infinity, NaN, Number.MAX_SAFE_INTEGER])('keeps invalid premium %s unknown', premium => {
    const result = calculateEmployeeProfitability({ ...base, policies: [{ ...base.policies[0], premium }] });
    expect(result.rows[0]).toMatchObject({ grossCommissionCents: null, missingCommissionCount: 1, complete: false });
  });

  it('accepts explicitly configured zero and 100% commission shares', () => {
    for (const producerShareBps of [0, 10000]) {
      const result = calculateEmployeeProfitability({ ...base, compensations: { producer: pay([term({ annualSalaryCents: 0, producerShareBps })]) } });
      expect(result.rows[0]).toMatchObject({ producerShareCents: producerShareBps * 10, salaryCents: 0, complete: true });
    }
  });

  it('keeps unassigned production separate and preserves known totals without inventing profit', () => {
    const result = calculateEmployeeProfitability({ ...base, assignments: {} });
    expect(result.rows.at(-1)).toMatchObject({ userId: null, name: 'Unassigned', grossCommissionCents: 100_000,
      producerShareCents: null, salaryCents: null, contributionCents: null, policyCount: 1, complete: false });
    expect(result.totals).toMatchObject({ grossCommissionCents: 100_000, contributionCents: null, complete: false });
  });

  it('exposes undated policies and makes full revenue totals incomplete', () => {
    const result = calculateEmployeeProfitability({ ...base, policies: [base.policies[0], { ...base.policies[0], id: 'undated', effectiveDate: '2026-02-30' }] });
    expect(result).toMatchObject({ undatedPolicyCount: 1, totals: { grossCommissionCents: null,
      knownGrossCommissionCents: 100_000, contributionCents: null, complete: false } });
    expect(result.warnings.join(' ')).toContain('no valid effective date');
    expect(result.rows[0]).toMatchObject({ grossCommissionCents: null, producerShareCents: null,
      netRevenueCents: null, contributionCents: null, salaryCents: 310_000, complete: false,
      knownGrossCommissionCents: 100_000, knownNetRevenueCents: 75_000 });
    expect(result.rows[0].warnings.join(' ')).toContain('no valid effective date');
  });

  it('only marks the affected employee incomplete for undated policies', () => {
    const result = calculateEmployeeProfitability({ ...base, policies: [base.policies[0],
      { ...base.policies[0], id: 'undated', accountId: 'unassigned-account', effectiveDate: null },
    ] });
    expect(result.rows[0]).toMatchObject({ userId: 'producer', grossCommissionCents: 100_000, complete: true });
    expect(result.rows.at(-1)).toMatchObject({ userId: null, grossCommissionCents: null, complete: false });
    expect(result.totals.complete).toBe(false);
  });

  it('excludes undated cancelled policies without making active production incomplete', () => {
    const result = calculateEmployeeProfitability({ ...base, policies: [base.policies[0],
      { ...base.policies[0], id: 'cancelled-undated', status: 'CANCELLED', effectiveDate: null },
    ] });
    expect(result).toMatchObject({ undatedPolicyCount: 0, cancelledPolicyCount: 0, totals: { complete: true, grossCommissionCents: 100_000 } });
    expect(result.warnings.join(' ')).toContain('cancelled policies with no valid effective date');
  });

  it('fails closed on duplicate policies and arithmetic overflow', () => {
    expect(() => calculateEmployeeProfitability({ ...base, policies: [base.policies[0], base.policies[0]] })).toThrow('duplicate');
    expect(() => calculateEmployeeProfitability({ ...base, from: '2025-01-01', to: '2026-12-31', policies: [],
      compensations: { producer: pay([term({ from: '2025-01-01', annualSalaryCents: Number.MAX_SAFE_INTEGER })]) } })).toThrow('too large');
  });
});

describe('compensation validation', () => {
  it('sorts a copied history and validates the employee identity', () => {
    const input = pay([term({ from: '2026-02-01' }), term({ to: '2026-01-31' })]);
    expect(validateCompensationRecord(input, 'producer').terms[0].from).toBe('2026-01-01');
    expect(input.terms[0].from).toBe('2026-02-01');
    expect(() => validateCompensationRecord(input, 'someone-else')).toThrow('Invalid');
  });

  it.each([
    [term(), term({ from: '2027-01-01' })],
    [term({ to: '2026-01-15' }), term({ from: '2026-01-15' })],
    [term({ from: '2026-02-30' })], [term({ from: '2026-03-01', to: '2026-02-28' })],
    [term({ annualSalaryCents: -1 })], [term({ annualSalaryCents: 10.5 })],
    [term({ producerShareBps: 10001 })], [term({ producerShareBps: -1 })], [term({ producerShareBps: 20.5 })],
  ])('rejects ambiguous or invalid terms %j', (...terms) => {
    expect(() => validateCompensationRecord(pay(terms as CompensationTerm[]))).toThrow();
  });

  it('bounds compensation history and version inputs', () => {
    expect(() => validateCompensationRecord(pay(Array.from({ length: 101 }, () => term())))).toThrow();
    for (const version of [-1, 1.5, Infinity]) expect(() => validateCompensationRecord({ ...pay(), version })).toThrow();
  });

  it('requires a valid, ordered and bounded date window', () => {
    for (const [from, to] of [['2026-02-30', '2026-03-01'], ['2026-02-02', '2026-02-01'], ['', '2026-01-01'], ['2020-01-01', '2026-01-01']]) {
      expect(() => validateProfitabilityWindow(from, to)).toThrow();
    }
    expect(validateProfitabilityWindow('2024-02-29', '2024-02-29')).toEqual({ from: '2024-02-29', to: '2024-02-29' });
  });
});
