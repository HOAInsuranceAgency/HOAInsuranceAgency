/** Fictional, in-memory preview only. Never import a runtime CRM or storage API. */
import type { Account, UserProfile } from '../../src/lib/client';
export type { Account, UserProfile, CrmDocument, Policy, Quote, Contact, Building, Loss } from '../../src/lib/client';
export type { AcordFormDef } from '../../src/lib/acordRegistry';
export type { AiFilledField } from '../../src/lib/acord';
export { ACORD_FORMS } from '../../src/lib/acordRegistry';
export { listAllPages } from '../../src/lib/pagination';

export const scenario = new URLSearchParams(location.search).get('scenario') || 'lead';
export const isClient = scenario === 'client';
const time = (hoursAgo = 0) => new Date(Date.now() - hoursAgo * 3600000).toISOString();
const field = (value: string | number | boolean, confidence = 'high', evidence = 'Listed in the signed property schedule.', source = '2026 Statement of values, page 2') => ({ value, confidence, evidence, source });
const extraction = {
  extractedAt: time(2), documentCount: 4,
  summary: 'Four documents describe 32 units across three buildings. The statement of values adds a renovated clubhouse and updates the replacement cost. Review the low-confidence coastal distance before applying it.',
  address: field('100 Example Street, Buildings A–C and community clubhouse'),
  unitCount: field(32, 'high', 'Unit schedule lists 12 units in A, 12 in B and 8 in C.'),
  totalInsuredValue: field(6850000, 'high', '2026 replacement cost totals $6,850,000 across the property.'),
  currentPolicyExpiration: field('2026-11-01', 'high', 'Policy term expires November 1, 2026.', 'Prior policy declarations, page 1'),
  firewallsVerified: field(true, 'medium', 'Masonry separation noted between residential buildings.'),
  milesToCoast: field(3.2, 'low', 'Application gives an approximate distance; verify with the property manager.', 'Prior application, page 5'),
  contacts: [
    { name: 'Alex Taylor', email: 'alex.propertymanager@example.test', phone: '6175550142', type: 'PROPERTY_MANAGER' },
    { name: 'Riley Chen', email: 'riley.board@example.test', phone: '6175550177', type: 'BOARD_MEMBER' },
  ],
  buildings: [
    { label: 'Building A', sqft: '18,500', yearBuilt: '1988', stories: '3', constructionType: 'JOISTED_MASONRY', roofYear: '2025', wiringYear: '2023' },
    { label: 'Community clubhouse and detached maintenance garage', sqft: '4,800', yearBuilt: '1995', stories: '1', constructionType: 'FRAME', roofYear: '2024' },
  ],
  losses: [{ dateOfLoss: '2024-02-11', lineOfBusiness: 'Commercial Property', typeOfLoss: 'Water damage', description: 'Pipe leak in Building B; repairs completed.', amountPaid: '14500', claimOpen: 'No' }],
};

export const account = {
  id: 'fictional-willow', name: 'Willow Court Condominium', stage: isClient ? 'CLIENT' : 'LEAD', type: 'ASSOCIATION',
  address: '100 Example St', city: 'Boston', state: 'MA', zip: '02110', unitCount: 28, totalInsuredValue: 5400000,
  currentPolicyExpiration: '2026-10-01', firewallsVerified: null, milesToCoast: null,
  createdAt: time(24 * 14), convertedAt: isClient ? time(24 * 4) : undefined,
  extractionStatus: scenario === 'empty' ? undefined : scenario === 'loading' ? 'PROCESSING' : scenario === 'error' ? 'FAILED' : 'COMPLETE',
  extractionError: scenario === 'error' ? 'Preview: extraction could not be completed. Try again.' : null,
  aiExtraction: scenario === 'empty' || scenario === 'loading' || scenario === 'error' ? null : JSON.stringify(extraction),
} as unknown as Account;
export const profile = { id: 'fictional-avery', firstName: 'Avery', lastName: 'Brooks', email: 'avery@example.test' } as UserProfile;

type Row = Record<string, unknown> & { id: string };
const file = (id: string, name: string, category: string, ocrStatus = 'COMPLETE', extra: Record<string, unknown> = {}): Row => ({
  id, entityType: 'ACCOUNT', entityId: account.id, name, category, s3Key: `preview/${id}/${name}`, contentType: 'application/pdf', sizeBytes: 1245000, ocrStatus, createdAt: time(Number(id.replace(/\D/g, '')) || 1),
  ...(ocrStatus === 'COMPLETE' ? { ocrText: 'WILLOW COURT CONDOMINIUM\n2026 Statement of Values\n\n100 Example Street, Boston, MA 02110\n\nBuilding A: 12 units, 18,500 square feet, joisted masonry. New roof in 2025.\nBuilding B: 12 units, 17,900 square feet.\nBuilding C: 8 units, 12,100 square feet.\nCommunity clubhouse: 4,800 square feet.\n\nTotal insured value: $6,850,000.\nCoverage includes common areas, detached maintenance garage and updated electrical systems.', ocrTables: JSON.stringify([[['Building', 'Units', 'Replacement cost'], ['Building A', '12', '$2,200,000'], ['Building B', '12', '$2,100,000'], ['Building C', '8', '$1,850,000'], ['Community clubhouse', '—', '$700,000']]]) } : {}), ...extra,
});
const documents: Row[] = scenario === 'empty' ? [] : [
  file('doc1', 'Willow_Court_Condominium_Association_2026_Statement_of_Values_With_Building_Schedule_Roof_Updates_Replacement_Cost_and_Clubhouse_FINAL_REVISED.pdf', 'STATEMENT_OF_VALUES'),
  file('doc2', '2025–2026 Prior policy declarations.pdf', 'PRIOR_POLICY', 'COMPLETE', isClient ? { policyId: 'policy-1' } : { quoteId: 'quote-1' }),
  file('doc3', 'Five-year loss runs — Willow Court.pdf', 'LOSS_RUNS', 'COMPLETE'),
  file('doc4', 'Roof replacement and electrical updates.pdf', 'PROPERTY_UPDATES', 'PROCESSING'),
  file('doc5', 'Willow Court board-approved budget 2026.pdf', 'BUDGET', 'PENDING', { sizeBytes: 254000 }),
  file('doc6', 'Scanned prior application.pdf', 'OTHER', 'FAILED', { ocrError: 'The scan is too faint to read. Upload a clearer copy.', sizeBytes: 18200 }),
  file('doc7', 'acord125-Willow_Court_Condominium_Association_Commercial_Insurance_Application-2026-09-30.pdf', 'ACORD_FORM', 'SKIPPED', { sizeBytes: 182300 }),
  file('doc8', 'acord140-Willow_Court_Condominium-2026-09-29-1of2.pdf', 'ACORD_FORM', 'SKIPPED', { sizeBytes: 242000 }),
];
const contacts: Row[] = scenario === 'empty' ? [] : [{ id: 'contact-1', accountId: account.id, name: 'Alex Taylor', email: 'alex.old@example.test', phone: '6175550142', type: 'PROPERTY_MANAGER', isPrimary: true }];
const buildings: Row[] = scenario === 'empty' ? [] : [{ id: 'building-1', accountId: account.id, label: 'Building A', sqft: 18000, yearBuilt: 1988, roofYear: 2010 }];
const losses: Row[] = [];
const policies: Row[] = [{ id: 'policy-1', accountId: account.id, policyNumber: 'PREVIEW-P1001', lines: ['Commercial Property', 'General Liability'], effectiveDate: '2026-11-01', expirationDate: '2027-11-01', status: 'ACTIVE' }];
const quotes: Row[] = [{ id: 'quote-1', accountId: account.id, lines: ['Commercial Property', 'General Liability'], effectiveDate: '2026-11-01', status: 'QUOTED' }, { id: 'quote-2', accountId: account.id, lines: ['Directors & Officers'], effectiveDate: '2026-11-01', status: 'PRESENTED' }];
const failed = new Set<string>();
async function ready(resource = '') {
  if (scenario === 'loading') await new Promise<void>(() => {});
  if (scenario === 'error' && resource && !failed.has(resource)) { failed.add(resource); throw new Error(`Preview: could not load ${resource}.`); }
}
type Filter = Record<string, { eq?: unknown }>;
function matches(row: Row, filter?: Filter) { return !filter || Object.entries(filter).every(([key, condition]) => condition.eq === undefined || row[key] === condition.eq); }
function model(rows: Row[], resource = '') {
  return {
    async list(input?: { filter?: Filter }) { await ready(resource); return { data: structuredClone(rows.filter(row => matches(row, input?.filter))) }; },
    async create(input: Record<string, unknown>) { const row = { ...input, id: crypto.randomUUID(), createdAt: time() }; rows.unshift(row); return { data: structuredClone(row) }; },
    async update(input: Record<string, unknown> & { id: string }) { const row = rows.find(item => item.id === input.id); if (!row) throw new Error('Preview record not found.'); Object.assign(row, input); return { data: structuredClone(row) }; },
    async delete({ id }: { id: string }) { const index = rows.findIndex(item => item.id === id); const row = index < 0 ? null : rows.splice(index, 1)[0]; return { data: row }; },
  };
}
const docModel = model(documents);
export const client = {
  models: {
    Document: {
      ...docModel,
      async list(input?: { filter?: Filter }) { await ready('generated forms'); return docModel.list(input); },
      async listDocumentByEntityId({ entityId }: { entityId: string }, input?: { filter?: Filter }) { await ready('documents'); return docModel.list({ filter: { ...input?.filter, entityId: { eq: entityId } } }); },
    },
    Account: {
      async get() { return { data: structuredClone(account) }; },
      async update(input: Record<string, unknown>) { Object.assign(account, input); return { data: structuredClone(account) }; },
    },
    Contact: model(contacts), Building: model(buildings), Loss: model(losses), Policy: model(policies), Quote: model(quotes),
    PriorCarrier: model([]), GlApplication: model([]), GlClassCode: model([]), Blanket: model([]),
  },
  mutations: {
    async startLeadExtraction() {
      await new Promise(resolve => setTimeout(resolve, 450));
      Object.assign(account, { extractionStatus: 'COMPLETE', extractionError: null, aiExtraction: JSON.stringify({ ...extraction, extractedAt: time() }) });
      return { data: { ok: true } };
    },
  },
};
export const fmtDateTime = (value?: string | null) => value ? new Date(value).toLocaleString('en-US') : '—';
export const fmtDate = (value?: string | null) => value ? new Date(`${value.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US') : '—';
export const fmtMoney = (value?: number | null) => value == null ? '—' : value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
export const fmtNum = (value?: number | null) => value == null ? '—' : value.toLocaleString('en-US');
export const fmtPhone = (value?: string | null) => value?.replace(/^(?:\+1)?(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3') || '—';
export const friendlyError = (error: unknown, fallback = 'Please try again.') => error instanceof Error && error.message ? error.message : fallback;
export const TEMPLATE_MISSING_MESSAGE = 'Upload an ACORD template in Settings.';

export function uploadData({ path }: { path: string; data: unknown; options?: unknown }) {
  return { result: Promise.resolve().then(() => {
    const row = documents.find(doc => doc.s3Key === path);
    if (row && row.category !== 'ACORD_FORM') Object.assign(row, { ocrStatus: 'COMPLETE', ocrText: 'Fictional preview upload. No file was sent to the CRM.' });
    return { path };
  }) };
}
export async function remove(_input: { path: string }) { return {}; }
export async function downloadFile(_path: string, { filename }: { filename: string }) {
  const url = URL.createObjectURL(new Blob([`Fictional preview of ${filename}.\nNo CRM file was downloaded.`], { type: 'text/plain' }));
  const link = document.createElement('a'); link.href = url; link.download = `${filename}.preview.txt`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const MAPPED_APP_FORM_KEYS = new Set(['acord125', 'acord126', 'acord140']);
export function buildingPages<T>(rows: T[]) { return rows.length ? Array.from({ length: Math.ceil(rows.length / 2) }, (_, i) => rows.slice(i * 2, i * 2 + 2)) : [[]]; }
export async function signatureFor(_profileId: string) { return null; }
export async function fillAcordApp(..._args: unknown[]) {
  return { pdf: null, bytes: new TextEncoder().encode('Fictional ACORD preview only.'), empty: [], missing: [], unsigned: undefined };
}
export async function aiFillGaps(_pdf: unknown, bytes: Uint8Array, ..._args: unknown[]) {
  await new Promise(resolve => setTimeout(resolve, 350));
  return { bytes, applied: [{ field: 'Description of operations', value: 'Residential condominium association with three buildings and a clubhouse.', why: 'Fictional statement of values and property schedule.' }], note: '' };
}
