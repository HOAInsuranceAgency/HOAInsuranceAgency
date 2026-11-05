import { createCommercialScenario } from '../../../fixtures/commercial';
export * from '../../../fixtures/presentation';

let state = createCommercialScenario();
/** Explicit per-test reset. No global mock, lifecycle hook or preview URL. */
export function resetCommercialFixtures() { state = createCommercialScenario(); }
export const commercialFixtures = {
  get accounts() { return state.accounts; },
  get plans() { return state.plans; },
  get team() { return state.team; },
};

function page<T>(rows: T[], input?: { nextToken?: string | null; limit?: number }) {
  const start = input?.nextToken == null ? 0 : Number(input.nextToken), limit = input?.limit ?? Math.max(rows.length, 1);
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid fictional page request.');
  return { data: structuredClone(rows.slice(start, start + limit)), nextToken: start + limit < rows.length ? String(start + limit) : null };
}
/** Only the model reads these tests require. Missing APIs fail visibly. */
export const client = { models: {
  Account: { async list(input?: { filter?: { stage?: { eq: string } }; nextToken?: string | null; limit?: number }) {
    return page(state.accounts.filter(row => !input?.filter?.stage?.eq || row.stage === input.filter.stage.eq), input);
  } },
  Quote: { async list(input?: { nextToken?: string | null; limit?: number }) { return page(state.quotes, input); } },
  Contact: { async list(input?: { nextToken?: string | null; limit?: number }) { return page(state.contacts, input); } },
  Policy: { async list(input?: { nextToken?: string | null; limit?: number }) { return page(state.policies, input); } },
} };

/** Read-only scenarios are explicit; writes belong in each test's own spy. */
export async function communicationRequest(operation: string, input: Record<string, unknown> = {}, write = false) {
  if (write) throw new Error('Declare writes in the individual test instead of the read-only fixture.');
  if (operation === 'team') return { team: structuredClone(state.team) };
  if (operation === 'commercialTable') {
    if (!Array.isArray(input.accountIds) || input.accountIds.some(id => typeof id !== 'string' || !state.plans[id])) throw new Error('Choose fictional account IDs.');
    return { items: (input.accountIds as string[]).map(accountId => ({ accountId, plan: structuredClone(state.plans[accountId]), salespersonId: 'sales', championId: 'champ' })) };
  }
  if (operation === 'lastContacts') {
    if (!Array.isArray(input.accounts) || input.accounts.some(row => !row || typeof row !== 'object' || typeof row.accountId !== 'string')) throw new Error('Choose fictional contact accounts.');
    return { items: (input.accounts as { accountId: string }[]).map(({ accountId }) => ({ accountId,
      contact: { at: '2026-09-14T13:00:00Z', channel: 'EMAIL', direction: 'OUTBOUND' }, complete: true })) };
  }
  throw new Error(`Unexpected fictional operation: ${operation}`);
}
