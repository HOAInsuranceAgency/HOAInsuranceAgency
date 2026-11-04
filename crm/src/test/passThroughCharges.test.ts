import { describe, expect, it } from 'vitest';
import { normalizeClientConditions, normalizePassThroughCharges, passThroughTotal, passThroughTotalCents, MAX_PASS_THROUGH_TOTAL_CENTS } from '../../../shared/passThroughCharges';
import { authorizedQuoteTerms } from '../../../shared/quoteAuthorization';
import { packageAssessment, emptyCommercialPlan, packageTerms } from '../../../shared/quotePackages';
import { validateInvoiceSourceCharges } from '../../amplify/functions/send-invoice/passThroughInvoice';

const charges = [
  { id: 'carrier-policy', kind: 'CARRIER_FEE', description: 'Carrier policy fee', amountCents: 50000 },
  { id: 'rt-brokerage', kind: 'WHOLESALER_FEE', description: 'RT Specialty brokerage fee', amountCents: 25000 },
  { id: 'ma-tax', kind: 'SURPLUS_LINES', description: 'Surplus lines tax', amountCents: 200000 },
];
const source = { accountId: 'a', passThroughCharges: charges };
const lines = charges.map(charge => ({ accountId: 'a', kind: charge.kind, description: charge.description, sourceQuoteChargeId: charge.id, retailAmount: charge.amountCents / 100, costAmount: charge.amountCents / 100 }));
const invoice = { accountId: 'a' };
const quote = { id: 'q', accountId: 'a', status: 'QUOTED', carrierId: 'carrier', premium: 50000, commissionPct: 10, lines: ['Property'], effectiveDate: '2027-01-01', expirationDate: '2028-01-01' };

describe('strict reviewed supplier charges', () => {
  it('normalizes JSON strings without losing charge identity and totals the reference packet', () => {
    expect(normalizePassThroughCharges(JSON.stringify(charges))).toEqual(charges);
    expect(passThroughTotalCents(charges)).toBe(275000); expect(passThroughTotal(charges)).toBe(2750);
    expect(normalizePassThroughCharges(undefined)).toEqual([]); expect(normalizePassThroughCharges(null)).toEqual([]);
  });
  it.each(['{bad', 'null', '{}', {}, [null], [{ ...charges[0], extra: true }], [charges[0], charges[0]], [{ ...charges[0], id: '../bad' }], [{ ...charges[0], kind: 'BROKER_FEE' }], [{ ...charges[0], amountCents: 0 }], [{ ...charges[0], amountCents: -1 }], [{ ...charges[0], amountCents: 1.5 }], [{ ...charges[0], amountCents: '500' }], [{ ...charges[0], amountCents: Number.MAX_SAFE_INTEGER }], [{ ...charges[0], description: 'x'.repeat(161) }], [{ ...charges[0], description: 'Hidden\namount' }]])('rejects malformed or unsafe recorded charges %j', value => {
    expect(() => normalizePassThroughCharges(value)).toThrow();
  });
  it('bounds both the row count and total', () => {
    expect(() => normalizePassThroughCharges(Array.from({ length: 31 }, (_, index) => ({ ...charges[0], id: `charge-${index}` })))).toThrow();
    expect(() => normalizePassThroughCharges([{ ...charges[0], amountCents: MAX_PASS_THROUGH_TOTAL_CENTS }, charges[1]])).toThrow('total exceeds');
  });
  it('validates separate public conditions and preserves legacy financial fingerprints when absent', () => {
    expect(normalizeClientConditions('  No flat cancellations.\r\n35% minimum earned premium.  ')).toBe('No flat cancellations.\n35% minimum earned premium.');
    expect(() => normalizeClientConditions('x'.repeat(6001))).toThrow();
    expect(() => normalizeClientConditions('hidden\0text')).toThrow();
    expect(authorizedQuoteTerms(quote)).toBe(authorizedQuoteTerms({ ...quote, passThroughCharges: [], clientConditions: '' }));
    const frozen = authorizedQuoteTerms({ ...quote, passThroughCharges: charges, clientConditions: '35% minimum earned premium.' });
    expect(frozen).not.toBe(authorizedQuoteTerms(quote));
    expect(frozen).toBe(authorizedQuoteTerms({ ...quote, passThroughCharges: JSON.stringify(charges), clientConditions: '35% minimum earned premium.' }));
    expect(frozen).not.toBe(authorizedQuoteTerms({ ...quote, passThroughCharges: [{ ...charges[0], amountCents: 60000 }, ...charges.slice(1)], clientConditions: '35% minimum earned premium.' }));
    expect(frozen).not.toBe(authorizedQuoteTerms({ ...quote, passThroughCharges: charges, clientConditions: '50% minimum earned premium.' }));
  });
  it('keeps premium and commission unchanged while package cost includes supplier charges and optional HOA fee', () => {
    const q = { ...quote, passThroughCharges: charges, brokerFee: 500, billType: 'AGENCY' };
    const plan = { ...emptyCommercialPlan('a'), requiredLines: ['Property'] }, option = { id: 'option', name: 'Option', quoteIds: ['q'], reviewed: { at: '2026-11-04', by: 'owner', terms: { q: packageTerms(q) } } };
    expect(packageAssessment(plan, option, [q], '2026-11-04')).toMatchObject({ complete: true, premiumCents: 5000000, passThroughCents: 275000, brokerFeeCents: 50000, clientTotalCents: 5325000, commissionCents: 500000, agencyRevenueCents: 550000 });
  });
});

describe('source-backed supplier invoice charges', () => {
  it('allows actual-cost supplier and tax rows only for a persisted legacy policy source', () => {
    const initial = { ...invoice, policyId: 'legacy-policy', sourcePricingVersion: 1 }, policy = { id: 'legacy-policy', accountId: 'a', premium: 50000, billType: 'AGENCY' };
    const premium = { accountId: 'a', kind: 'PREMIUM', retailAmount: 50000, costAmount: 45000 };
    const legacyRows = ['CARRIER_FEE', 'WHOLESALER_FEE', 'TAX', 'SURPLUS_LINES', 'STAMPING_FEE'].map(kind=>({ accountId: 'a', kind, description: kind, retailAmount: 100, costAmount: 100 }));
    expect(() => validateInvoiceSourceCharges({ invoice: initial, source: policy, lines: [premium, ...legacyRows] })).not.toThrow();
    for(const currentSource of [{ ...policy, passThroughCharges: [] }, { ...policy, id: 'another-policy' }])expect(()=>validateInvoiceSourceCharges({invoice:initial,source:currentSource,lines:[premium,...legacyRows]})).toThrow('reviewed source quote');
    expect(()=>validateInvoiceSourceCharges({invoice:{...initial,policyId:null},source:policy,lines:[premium,...legacyRows]})).toThrow('reviewed source quote');
    expect(()=>validateInvoiceSourceCharges({invoice:initial,source:policy,lines:[{...premium,retailAmount:52000},...legacyRows]})).toThrow('gross premium exactly once');
    expect(()=>validateInvoiceSourceCharges({invoice:initial,source:policy,lines:[premium,{...legacyRows[0],costAmount:0}]})).toThrow('without agency markup');
    expect(()=>validateInvoiceSourceCharges({invoice:initial,source:policy,lines:[premium,{...legacyRows[0],retailAmount:-100,costAmount:-100}]})).toThrow('positive supplier');
    expect(()=>validateInvoiceSourceCharges({invoice:initial,source:policy,lines:[premium,{...legacyRows[0],retailAmount:0,costAmount:0}]})).toThrow('positive supplier');
    for(const description of ['', 'x'.repeat(161), 'Hidden\ncharge'])expect(()=>validateInvoiceSourceCharges({invoice:initial,source:policy,lines:[premium,{...legacyRows[0],description}]})).toThrow('client label');
    expect(()=>validateInvoiceSourceCharges({invoice:initial,source:policy,lines:[premium,{kind:'OTHER',retailAmount:100,costAmount:0}]})).toThrow('initial policy invoice');
    expect(()=>validateInvoiceSourceCharges({invoice:initial,source:policy,lines:[{accountId:'a',kind:'TAX',retailAmount:0,costAmount:0}],requireAll:false})).not.toThrow();
  });
  it('retains an unflagged issued manual invoice snapshot when source charges are recorded later', () => {
    const legacyRows = [{ kind: 'PREMIUM', retailAmount: 50000, costAmount: 45000 }, { accountId: 'a', kind: 'TAX', retailAmount: 2000, costAmount: 2000 }];
    expect(()=>validateInvoiceSourceCharges({invoice:{...invoice,status:'SENT'},source:{...source,premium:50000},lines:legacyRows})).not.toThrow();
    expect(()=>validateInvoiceSourceCharges({invoice:{...invoice,status:'DRAFT'},source:{...source,premium:50000},lines:legacyRows})).toThrow();
  });
  it('fences the full initial gross price, including the reported overcharge regression', () => {
    const initial = { ...invoice, sourcePricingVersion: 1 }, initialSource = { ...source, premium: 50000, billType: 'AGENCY' };
    const premium = { accountId: 'a', kind: 'PREMIUM', retailAmount: 50000, costAmount: 45000 };
    expect(() => validateInvoiceSourceCharges({ invoice: initial, source: initialSource, lines: [premium, ...lines] })).not.toThrow();
    for (const altered of [[{ ...premium, retailAmount: 52000 }, ...lines], [premium, premium, ...lines], [...lines], [premium, ...lines, { kind: 'OTHER', retailAmount: 2000, costAmount: 0 }], [premium, ...lines, { kind: 'ENDORSEMENT', retailAmount: 2000, costAmount: 1000 }]]) expect(() => validateInvoiceSourceCharges({ invoice: initial, source: initialSource, lines: altered })).toThrow();
    const tax = { id: 'tax', kind: 'TAX', description: 'Tax', amountCents: 100000 };
    expect(() => validateInvoiceSourceCharges({ invoice: initial, source: { accountId: 'a', premium: 10000, passThroughCharges: [tax] }, lines: [{ kind: 'PREMIUM', retailAmount: 12000, costAmount: 8000 }, { accountId: 'a', kind: 'TAX', sourceQuoteChargeId: 'tax', description: 'Tax', retailAmount: 1000, costAmount: 1000 }, { kind: 'BROKER_FEE', retailAmount: 500, costAmount: 0 }] })).toThrow('gross premium exactly once');
  });
  it('preserves old unflagged adjustment rows and permits draft gross-premium seeding before actual cost is entered', () => {
    expect(() => validateInvoiceSourceCharges({ invoice, source: { accountId: 'a', premium: 50000 }, lines: [{ kind: 'ENDORSEMENT', retailAmount: 1000, costAmount: 800 }] })).not.toThrow();
    expect(() => validateInvoiceSourceCharges({ invoice: { ...invoice, sourcePricingVersion: 1 }, source: { accountId: 'a', premium: 50000 }, lines: [{ kind: 'PREMIUM', retailAmount: 50000, costAmount: null }], requireAll: false })).not.toThrow();
    expect(() => validateInvoiceSourceCharges({ invoice: { ...invoice, sourcePricingVersion: 1 }, source: { accountId: 'a', premium: 50000 }, lines: [{ kind: 'PREMIUM', retailAmount: 50000, costAmount: null }] })).toThrow('actual carrier or wholesaler');
  });
  it('accepts the exact gross premium with reviewed supplier remittance and sourced pass-through rows', () => {
    expect(() => validateInvoiceSourceCharges({ invoice, source, lines: [{ accountId: 'a', kind: 'PREMIUM', retailAmount: 50000, costAmount: 45000 }, ...lines] })).not.toThrow();
  });
  it('rejects missing, duplicate, extra and stale source charges, including on a sent invoice retry', () => {
    for (const altered of [lines.slice(1), [...lines, lines[0]], [...lines, { ...lines[0], sourceQuoteChargeId: 'unquoted' }], [{ ...lines[0], retailAmount: 600, costAmount: 600 }, ...lines.slice(1)]]) expect(() => validateInvoiceSourceCharges({ invoice, source, lines: altered })).toThrow();
  });
  it.each([{ accountId: 'other' }, { kind: 'OTHER' }, { description: 'Agency fee' }, { costAmount: 0 }, { sourceQuoteChargeId: null }])('rejects altered source line %j', patch => {
    expect(() => validateInvoiceSourceCharges({ invoice, source, lines: [{ ...lines[0], ...patch }, ...lines.slice(1)] })).toThrow();
  });
  it('rejects a source from a different account and a malformed stored charge list', () => {
    expect(() => validateInvoiceSourceCharges({ invoice, source: { ...source, accountId: 'other' }, lines })).toThrow('different account');
    expect(() => validateInvoiceSourceCharges({ invoice, source: { ...source, passThroughCharges: '{bad' }, lines })).toThrow();
  });
  it('preserves legacy tax billing when saving an unchanged empty source list', () => {
    expect(() => validateInvoiceSourceCharges({ invoice, source: { ...source, passThroughCharges: [] }, lines: [{ accountId: 'a', kind: 'TAX', retailAmount: 100, costAmount: 100 }] })).not.toThrow();
    expect(() => validateInvoiceSourceCharges({ invoice, source: { ...source, passThroughCharges: [] }, lines: [{ accountId: 'a', kind: 'CARRIER_FEE', retailAmount: 100, costAmount: 100 }] })).toThrow('reviewed source');
  });
  it('retains legacy unanchored tax lines at actual cost without permitting supplier fee markup', () => {
    const legacyTax = { accountId: 'a', kind: 'TAX', retailAmount: 100, costAmount: 100 };
    expect(() => validateInvoiceSourceCharges({ invoice, source: { accountId: 'a' }, lines: [legacyTax] })).not.toThrow();
    expect(() => validateInvoiceSourceCharges({ invoice, source: { accountId: 'a' }, lines: [{ ...legacyTax, costAmount: 99 }] })).toThrow('without agency markup');
    expect(() => validateInvoiceSourceCharges({ invoice, source: { accountId: 'a' }, lines: [{ ...legacyTax, kind: 'WHOLESALER_FEE' }] })).toThrow('reviewed source');
  });
  it.each([null, undefined])('requires reviewed premium cost instead of treating %s as agency revenue', costAmount => {
    expect(() => validateInvoiceSourceCharges({ invoice, source: null, lines: [{ kind: 'PREMIUM', retailAmount: 50000, costAmount }] })).toThrow('actual carrier or wholesaler');
    expect(() => validateInvoiceSourceCharges({ invoice, source: null, lines: [{ kind: 'ENDORSEMENT', retailAmount: 500, costAmount }] })).toThrow('actual carrier or wholesaler');
    expect(() => validateInvoiceSourceCharges({ invoice, source: null, lines: [{ kind: 'PREMIUM', retailAmount: 50000, costAmount: 0 }] })).not.toThrow();
  });
});
