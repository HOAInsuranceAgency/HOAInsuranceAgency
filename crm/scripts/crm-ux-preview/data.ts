import { accounts, quotes, carriers } from '../commercial-preview/fixtures';
import type { UserProfile } from '../../src/lib/client';
export const profile = { id: 'profile-preview', userId: 'sales', firstName: 'Alex', lastName: 'Agent', role: 'ADMIN', email: 'alex@example.test', onboardingComplete: true } as UserProfile;
const contacts = accounts.map(a => ({ id: `contact-${a.id}`, accountId: a.id, name: 'Jane Smith', email: 'jane@example.test', phone: '(617) 555-0123', isPrimary: true }));
export const records: Record<string, any[]> = {
  Account: accounts, Quote: quotes,
  Carrier: carriers.map(c => ({ ...c, appointed: true, states: ['MA', 'RI', 'CT'], primaryContactName: 'Morgan Underwriter', primaryContactEmail: 'underwriter@example.test' })),
  Contact: contacts, UserProfile: [profile],
  Policy: [{ id: 'cedar-policy', accountId: 'cedar', carrierId: carriers[0].id, policyNumber: 'DEMO-1001', status: 'ACTIVE', lines: ['Property'], premium: 11000, effectiveDate: '2026-10-01', expirationDate: '2027-10-01' }],
  Document: [{ id: 'file1', entityType: 'ACCOUNT', entityId: 'willow', name: '2026 renewal application.pdf', category: 'APPLICATION', sizeBytes: 121000, ocrStatus: 'COMPLETE', createdAt: '2026-09-01T13:00:00Z' }],
  MarketingTask: Array.from({ length: 38 }, (_, i) => ({ id: `deadline-${i}`, accountId: accounts[i % 3].id, accountName: accounts[i % 3].name, carrierId: carriers[i % 5].id, carrierName: carriers[i % 5].name, status: 'OPEN', lines: ['Property'], submitBy: '2026-10-01', expirationDate: '2026-11-01' })),
};
const reject = async () => { throw new Error('Preview only: mutations are disabled.'); };
function filter(rows: any[], input: any = {}) {
  return rows.filter(row => Object.entries(input.filter ?? {}).every(([field, value]: any) => value.eq === undefined || row[field] === value.eq) && (!input.accountId || row.accountId === input.accountId));
}
const models = new Proxy({}, { get: (_, model: string) => new Proxy({}, { get: (_, op: string) => {
  const rows = records[model] ?? [];
  if (['create', 'update', 'delete'].includes(op)) return reject;
  if (op === 'get') return async ({ id }: any) => ({ data: rows.find(r => r.id === id) ?? null });
  if (op === 'observeQuery') return (input: any) => ({ subscribe: ({ next }: any) => { next({ items: filter(rows, input), isSynced: true }); return { unsubscribe() {} }; } });
  return async (input: any) => ({ data: filter(rows, input), nextToken: null });
} }) });
export function generateClient() { return { models, mutations: new Proxy({}, { get: () => reject }), queries: new Proxy({}, { get: (_, op) => async () => ({ data: op === 'honeycombSubmissionSettings' ? { enabled: false } : op === 'listTeamUsers' ? JSON.stringify({ users: [{ userId: 'sales', email: profile.email, groups: ['ADMIN'] }] }) : [] }) }) }; }
