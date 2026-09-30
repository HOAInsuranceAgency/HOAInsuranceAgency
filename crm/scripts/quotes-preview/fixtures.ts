/** In-memory fictional data only. This entry point never loads the API client. */
import { emptyCommercialPlan, packageAssessment, packageTerms, parseEstimate, type CommercialPlan, type PackageOption } from '../../../shared/quotePackages';
import { authorizedQuoteTerms } from '../../../shared/quoteAuthorization';
import type { Account, Carrier, Quote } from '../../src/lib/client';
export type { Account, Carrier, Quote, Policy } from '../../src/lib/client';
export type { TeamEligibility } from '../../../shared/leadWorkflow';
export { listAllPages } from '../../src/lib/pagination';

// Mirrors src/lib/client.ts exactly; importing that module would initialize Amplify.
export const LINES_OF_BUSINESS = ['Commercial Property', 'Crime/Fidelity', 'D&O', 'Earthquake', 'Flood', 'General Liability', 'HO-6', 'Residential Property', 'Umbrella', 'Workers Comp'];
export const fmtMoney = (value?: number | null) => value == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
export const fmtNum = (value?: number | null) => value == null ? '—' : value.toLocaleString('en-US');
export function normalizePhone(value: string) {
  const text = value.trim(), digits = text.replace(/\D/g, '');
  return text.startsWith('+') || /[A-Za-z]/.test(text) || digits.length !== 10 ? text : `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}
export const fmtDate = (value?: string | null) => value ? new Date(`${value.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US') : '—';
export const friendlyError = (error: unknown, fallback = 'Please try again.') => error instanceof Error && error.message ? error.message : fallback;
const params = new URLSearchParams(window.location.search);
export const scenario = params.get('scenario') || 'empty';
const today = new Date().toISOString().slice(0, 10);
const future = (days: number) => new Date(Date.parse(`${today}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
export const account = {
  id: 'fictional-willow', name: 'Willow Court Condominium', type: 'ASSOCIATION', stage: 'LEAD',
  city: 'Boston', state: 'MA', createdAt: `${future(-14)}T13:00:00Z`,
} as Account;
export const carriers = [
  { id: 'harbor', name: 'Harbor Mutual' },
  { id: 'pine', name: 'Pine Insurance' },
  { id: 'summit', name: 'Summit Specialty' },
] as Carrier[];
const quote = (id: string, carrierId: string, lines: string[], premium: number) => ({
  id, accountId: account.id, carrierId, lines, premium, commissionPct: 12.5, status: 'QUOTED',
  effectiveDate: future(30), expirationDate: future(395), offerExpiresAt: future(14),
  perOccurrenceDeductible: 5000, blanketLimit: 4000000,
  createdAt: `${future(-2)}T13:00:00Z`, updatedAt: `${today}T13:00:00Z`,
}) as Quote;
export const quotes: Quote[] = ['populated', 'selected', 'estimates'].includes(scenario) ? [
  quote('bundle', 'harbor', ['Commercial Property', 'General Liability', 'D&O'], 18000),
  quote('property', 'pine', ['Commercial Property', 'General Liability'], 14200),
  quote('do', 'summit', ['D&O'], 2200),
] : [];
const reviewed = (quoteIds: string[]) => ({
  at: new Date().toISOString(), by: 'fictional-producer',
  terms: Object.fromEntries(quoteIds.map(id => [id, packageTerms(quotes.find(q => q.id === id)!)])),
});
const options: PackageOption[] = quotes.length ? [
  { id: 'bundle', name: 'Bundled coverage', quoteIds: ['bundle'], reviewed: reviewed(['bundle']) },
  { id: 'separate', name: 'Separate property and D&O', quoteIds: ['property', 'do'], reviewed: reviewed(['property', 'do']) },
] : [];
const plan: CommercialPlan = {
  ...emptyCommercialPlan(account.id), version: 1, estimatedCents: quotes.length ? 225000 : null,
  requiredLines: quotes.length ? ['Commercial Property', 'General Liability', 'D&O'] : [], options,
  ...(scenario === 'selected' ? { selectedOptionId: 'separate', selectedTerms: reviewed(['property', 'do']).terms } : {}),
};

async function readReady() {
  if (scenario === 'loading') await new Promise<void>(() => {});
  if (scenario === 'error') throw new Error('Preview: the records could not be loaded.');
}
type Row = { id: string; [key: string]: unknown };
function store(rows: Row[]) {
  return {
    async list() { await readReady(); return { data: structuredClone(rows) }; },
    async get({ id }: { id: string }) { return { data: structuredClone(rows.find(row => row.id === id) ?? null) }; },
    async create(input: Record<string, unknown>) { const data = { ...input, id: `fictional-${crypto.randomUUID()}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; rows.push(data); return { data: structuredClone(data) }; },
    async update(input: Row) { const row = rows.find(item => item.id === input.id); if (!row) return { data: null, errors: [{ message: 'Fictional record not found.' }] }; Object.assign(row, input, { updatedAt: new Date().toISOString() }); return { data: structuredClone(row) }; },
  };
}
const estimateRows = scenario === 'estimates' || params.get('estimate') === 'ready' ? [{
  id: 'fictional-estimate', accountId: account.id, status: 'READY', price: 17350,
  createdAt: new Date().toISOString(), estimationId: 'fictional-HC-001',
  result: JSON.stringify({ isOkToSubmit: true, currency: 'USD' }),
  input: JSON.stringify({ address: '100 Example Street, Boston, MA', submissionData: { buildingType: 'condominium', grossSQFeet: 32000, replacementValue: 4000000, numUnits: 24 } }),
}] : [];
export const client = {
  models: {
    Quote: store(quotes as unknown as Row[]), Carrier: store(carriers as unknown as Row[]),
    Account: store([account as unknown as Row]), Policy: store([]), Invoice: store([]), Document: store([]), PfLoan: store([]),
    HoneycombEstimate: { async listHoneycombEstimateByAccountId() { await readReady(); return { data: structuredClone(estimateRows) }; } },
  },
  mutations: { async servicePfLoan() { return { data: JSON.stringify({ ok: true }) }; } },
};
export async function communicationRequest<T>(operation: string, input: Record<string, unknown> = {}, _mutation?: boolean): Promise<T> {
  await readReady();
  if (operation === 'team') return { team: [{ userId: 'fictional-producer', name: 'Avery Brooks', salesperson: true, enabled: true }] } as T;
  if (operation === 'commercialTable') return { items: (input.accountIds as string[]).map(accountId => ({ accountId, plan: structuredClone(plan), salespersonId: 'fictional-producer' })) } as T;
  if (operation === 'authorizeBind') {
    const row = quotes.find(q => q.id === input.quoteId);
    if (!row) throw new Error('Fictional quote not found.');
    Object.assign(row, { bindAuthorizedAt: new Date().toISOString(), bindAuthorizedTerms: authorizedQuoteTerms(row) });
    return { ok: true } as T;
  }
  if (operation !== 'saveCommercial') throw new Error('This preview cannot run that operation.');
  if (input.version !== plan.version) throw new Error('Refresh this preview before saving.');
  if (input.action === 'ESTIMATE') plan.estimatedCents = parseEstimate(input.amount);
  else if (input.action === 'SELECT') {
    const option = plan.options.find(item => item.id === input.optionId);
    if (!option) throw new Error('Fictional option not found.');
    const assessment = packageAssessment(plan, option, quotes, today);
    if (!assessment.complete) throw new Error(assessment.problems.join('. '));
    plan.selectedOptionId = option.id; plan.selectedTerms = reviewed(option.quoteIds).terms;
  } else if (input.action === 'CLEAR_SELECTION') { plan.selectedOptionId = null; plan.selectedTerms = undefined; }
  else if (input.action === 'REMOVE_OPTION') plan.options = plan.options.filter(item => item.id !== input.optionId);
  else if (input.action === 'SAVE_OPTION') {
    const option: PackageOption = { id: String(input.optionId || `fictional-option-${plan.version}`), name: String(input.name), quoteIds: input.quoteIds as string[] };
    plan.requiredLines = input.requiredLines as string[];
    if (input.reviewed) option.reviewed = reviewed(option.quoteIds);
    plan.options = [...plan.options.filter(item => item.id !== option.id), option];
  } else throw new Error('This preview cannot run that action.');
  plan.version++;
  return { plan: structuredClone(plan) } as T;
}
