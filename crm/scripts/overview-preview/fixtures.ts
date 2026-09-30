/** Fictional local data only. Type imports never initialize the CRM client. */
import type { Account, Contact } from '../../src/lib/client';
export type { Account, Contact } from '../../src/lib/client';
export { listAllPages } from '../../src/lib/pagination';
export { validateAccountFields } from '../../src/lib/accountValidation';

export const scenario = new URLSearchParams(location.search).get('scenario') || 'populated';
export const isClient = scenario === 'client';
const isEmpty = scenario === 'empty';
const time = (hoursAgo = 0) => new Date(Date.now() - hoursAgo * 3600000).toISOString();
export const account = {
  id: 'fictional-willow', name: 'Willow Court Condominium', stage: isClient ? 'CLIENT' : 'LEAD', type: 'ASSOCIATION',
  createdAt: time(24 * 14), convertedAt: isClient ? time(24 * 4) : null,
  ...(isEmpty ? {} : {
    legalName: 'Willow Court Condominium Association of Massachusetts, Inc.',
    fein: '123456789', sicCode: '6513', naicsCode: '813990', legalEntityType: 'NOT_FOR_PROFIT',
    annualRevenue: 480000, totalInsuredValue: 6850000,
    currentAgent: 'Example Community Insurance Group', currentPolicyExpiration: '2026-11-01',
    notes: 'The board meets on the first Thursday of each month. Alex is coordinating the renewal and will provide the updated loss runs.\n\nInclude the clubhouse and detached maintenance garage when comparing coverage.',
    leadSource: 'GOOGLE_AD_WEBSITE', source: 'website-quote',
    address: '100 Example Street, Buildings A–C', city: 'Boston', county: 'Suffolk', state: 'MA', zip: '02110',
    incorporated: true, unitCount: 32, propertyType: 'CONDO', rentalPct: 15, fireDistrict: 'Boston Fire Department — District 3',
    firewallsVerified: true, coastal: true, milesToCoast: 3.2,
    otherUpdates: 'Clubhouse roof replaced in 2024; Building A electrical panels upgraded in 2023. Walkways and exterior lighting replaced in 2025.',
    coverPhotoKey: 'preview/Willow-Court-cover.jpg', aerialPhotoKey: 'preview/Willow-Court-aerial.jpg',
    plotPlanKey: 'preview/Willow_Court_Condominium_Association_Buildings_A_B_C_Clubhouse_and_Detached_Maintenance_Garage_Site_Plan_REVISED_2026.pdf',
  }),
} as unknown as Account;

const contacts: Contact[] = isEmpty ? [] : [
  { id: 'contact-alex', accountId: account.id, name: 'Alex Taylor', type: 'MANAGER', email: 'alex.propertymanager@example.test', phone: '6175550142', notes: 'Best reached weekday mornings. Coordinates vendor access and renewal documents.', isPrimary: true },
  { id: 'contact-riley', accountId: account.id, name: 'Riley Chen', type: 'PRESIDENT', email: 'riley.chen.board.president@example.test', phone: '6175550177', notes: 'Board president. Please copy on coverage decisions.', isPrimary: false },
  { id: 'contact-jordan', accountId: account.id, name: 'Jordan Ellis — Community Management Accounting', type: 'ACCOUNTING', email: 'jordan.ellis.community.management.accounting@example.test', phone: '6175550128', notes: 'Handles invoices and the annual association budget.', isPrimary: false },
] as unknown as Contact[];
const failed = new Set<string>();
async function readReady() {
  if (scenario === 'loading') await new Promise<void>(() => {});
  if (scenario === 'error' && !failed.has('contacts-read')) { failed.add('contacts-read'); throw new Error('Preview: contacts could not be loaded.'); }
}
async function writeReady(kind: string) {
  await new Promise(resolve => setTimeout(resolve, 250));
  if (scenario === 'error' && !failed.has(kind)) { failed.add(kind); throw new Error('Preview: this change could not be saved. Try again.'); }
}
export const client = { models: {
  Account: {
    async get() { return { data: structuredClone(account) }; },
    async update(input: Record<string, unknown>) { await writeReady('account-update'); Object.assign(account, input); return { data: structuredClone(account) }; },
  },
  Contact: {
    async list(input?: { filter?: { accountId?: { eq?: string } } }) {
      await readReady();
      return { data: structuredClone(contacts.filter(contact => !input?.filter?.accountId?.eq || contact.accountId === input.filter.accountId.eq)) };
    },
    async create(input: Record<string, unknown>) {
      await writeReady('contact-create'); const row = { ...input, id: crypto.randomUUID(), createdAt: time() } as unknown as Contact;
      contacts.push(row); return { data: structuredClone(row) };
    },
    async update(input: Record<string, unknown> & { id: string }) {
      await writeReady('contact-update'); const row = contacts.find(contact => contact.id === input.id);
      if (!row) throw new Error('Preview contact not found.');
      Object.assign(row, input); return { data: structuredClone(row) };
    },
    async delete({ id }: { id: string }) {
      await writeReady('contact-delete'); const index = contacts.findIndex(contact => contact.id === id);
      const row = index < 0 ? null : contacts.splice(index, 1)[0]; return { data: row };
    },
  },
} };

export const fmtDate = (value?: string | null) => value ? new Date(`${value.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US') : '—';
export const fmtNum = (value?: number | null) => value == null ? '—' : value.toLocaleString('en-US');
export function normalizePhone(value: string) {
  const text = value.trim(); if (text.startsWith('+') || /[A-Za-z]/.test(text)) return text;
  const digits = text.replace(/\D/g, ''); if (digits.length !== 10) return text;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}
export const fmtPhone = (value?: string | null) => value?.trim() ? normalizePhone(value) : '—';
export const friendlyError = (error: unknown, fallback = 'Please try again.') => error instanceof Error && error.message ? error.message : fallback;
export const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'];
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export function assertNoErrors(result: { errors?: { message: string }[] }) {
  if (result.errors?.length) throw new Error(result.errors.map(error => error.message).join('; '));
}
export function unwrap<T>(result: { data: T | null; errors?: { message: string }[] }): T {
  assertNoErrors(result); if (result.data == null) throw new Error('The server accepted that but returned nothing.'); return result.data;
}
const imageUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
const coverUrl = imageUrl('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 440"><rect fill="#dcebf1" width="800" height="440"/><rect y="300" width="800" height="140" fill="#a9bc9a"/><path d="M0 350h800v90H0z" fill="#cbd1cf"/><rect x="80" y="120" width="640" height="210" fill="#e9e0d2"/><path d="M45 120 180 45h455l120 75z" fill="#697888"/><rect x="375" y="215" width="60" height="115" fill="#586a78"/><g fill="#91b4c5"><path d="M110 155h65v55h-65zM215 155h65v55h-65zM320 155h65v55h-65zM425 155h65v55h-65zM530 155h65v55h-65zM635 155h55v55h-55zM110 240h65v55h-65zM215 240h65v55h-65zM530 240h65v55h-65zM635 240h55v55h-55z"/></g><g fill="#789b7e"><circle cx="40" cy="260" r="45"/><circle cx="755" cy="265" r="50"/></g><text x="28" y="412" font-family="Arial" font-size="19" fill="#445b66">Fictional site illustration</text></svg>');
const aerialUrl = imageUrl('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 440"><rect fill="#b8c9a6" width="800" height="440"/><path d="M0 350h800v70H0zM360 0h70v440h-70z" fill="#d8d4ca"/><g fill="#6d8190" stroke="#eff1eb" stroke-width="8"><rect x="75" y="70" width="205" height="115"/><rect x="505" y="70" width="205" height="115"/><rect x="75" y="230" width="205" height="80"/><rect x="520" y="245" width="150" height="70"/></g><g fill="#759877"><circle cx="37" cy="56" r="29"/><circle cx="745" cy="225" r="28"/><circle cx="318" cy="263" r="28"/><circle cx="475" cy="40" r="24"/></g><g font-family="Arial" fill="#f5f7f7" font-size="25" text-anchor="middle"><text x="175" y="137">Building A</text><text x="605" y="137">Building B</text><text x="175" y="280">Building C</text><text x="595" y="288" font-size="20">Clubhouse</text></g><text x="28" y="401" font-family="Arial" font-size="19" fill="#445b66">Fictional aerial diagram</text></svg>');
const uploads = new Map<string, string>();
export async function getUrl({ path }: { path: string }) {
  if (scenario === 'loading') await new Promise<void>(() => {});
  return { url: new URL(uploads.get(path) ?? (path.includes('aerial') ? aerialUrl : coverUrl)) };
}
export function uploadData({ path, data }: { path: string; data: Blob; options?: unknown }) {
  return { result: writeReady('photo-upload').then(() => {
    const previous = uploads.get(path); if (previous) URL.revokeObjectURL(previous);
    uploads.set(path, URL.createObjectURL(data)); return { path };
  }) };
}
export async function remove({ path }: { path: string }) {
  await writeReady('photo-remove'); const previous = uploads.get(path); if (previous) URL.revokeObjectURL(previous); uploads.delete(path); return {};
}
