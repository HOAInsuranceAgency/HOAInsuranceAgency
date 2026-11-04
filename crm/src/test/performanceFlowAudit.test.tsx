/** Opt-in deterministic request-waterfall audit. Run through scripts/performance-audit.mjs. */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { writeFileSync } from 'node:fs';

const h = vi.hoisted(() => ({
  models: {} as Record<string, Record<string, ReturnType<typeof vi.fn>>>,
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
  request: vi.fn(), pending: 0, calls: [] as { operation: string; startMs: number; endMs: number; rows: number; bytes: number }[],
  epoch: 0, role: 'ADMIN', fixtureSize: 600, records: {} as Record<string, Record<string, unknown>[]>,
  saveReport: vi.fn(),
}));
vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ models: h.models, mutations: h.mutations }) }));
vi.mock('../lib/communications', () => ({ communicationRequest: h.request }));
vi.mock('../lib/reportDownload', async original => ({ ...await original<typeof import('../lib/reportDownload')>(), saveReport: h.saveReport }));
import { AdminContext } from '../lib/auth';
import { AccountsListDataProvider } from '../lib/accountsListData';
import AccountsList from '../pages/AccountsList';
import AccountDetail from '../pages/AccountDetail';
import LeadWorkflowPanel from '../components/LeadWorkflowPanel';
import { emptyCommercialPlan, pendingCommission, type PackageQuote } from '../../../shared/quotePackages';

const enabled = process.env.CRM_PERF_AUDIT === '1';
const delayMs = Number(process.env.CRM_PERF_DELAY_MS ?? 10);
const report: Record<string, unknown>[] = [];
const team = [{ userId: 'alice', name: 'Alice Agent', salesperson: true, enabled: true, available: true }];
const accountId = 'a0000';
const commercialEntry = (id: string) => ({ accountId: id, salespersonId: 'alice', workflowVersion: 1,
  plan: { ...emptyCommercialPlan(id), estimatedCents: 50000 },
  snooze: { accountId: id, version: 0, followUpOn: null, note: '' }, disposition: Number(id.slice(1)) % 2 ? 'ACTIVE' : 'BOUND' });
function matches(row: Record<string, unknown>, filter: unknown): boolean {
  if (!filter || typeof filter !== 'object') return true;
  return Object.entries(filter).every(([field, raw]) => {
    if (field === 'and') return (raw as unknown[]).every(f => matches(row, f));
    if (field === 'or') return (raw as unknown[]).some(f => matches(row, f));
    const condition = raw as Record<string, unknown>;
    if ('eq' in condition) return row[field] === condition.eq;
    return true;
  });
}
async function service<T>(operation: string, value: T, rows = 0): Promise<T> {
  const call = { operation, startMs: Date.now() - h.epoch, endMs: 0, rows, bytes: Buffer.byteLength(JSON.stringify(value), 'utf8') };
  h.calls.push(call); h.pending++;
  await new Promise(resolve => setTimeout(resolve, delayMs));
  h.pending--; call.endMs = Date.now() - h.epoch;
  return value;
}
function modelList(model: string, operation: string, input: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  const args = { ...input, ...options };
  let rows = h.records[model] ?? [];
  if (input.entityId) rows = rows.filter(row => row.entityId === input.entityId);
  if (input.userId) rows = rows.filter(row => row.userId === input.userId);
  rows = rows.filter(row => matches(row, args.filter));
  const offset = Number(args.nextToken ?? 0), limit = Number(args.limit ?? 100);
  const data = rows.slice(offset, offset + limit);
  return service(`${model}.${operation}`, { data, nextToken: offset + limit < rows.length ? String(offset + limit) : null }, data.length);
}
function fixture() {
  const accounts = Array.from({ length: h.fixtureSize }, (_, index) => ({
    id: `a${String(index).padStart(4, '0')}`, name: `Fixture Association ${String(index).padStart(4, '0')}`,
    stage: index % 2 ? 'LEAD' : 'CLIENT', type: 'ASSOCIATION', city: 'Boston', state: 'MA',
    leadSource: 'ORGANIC_WEBSITE', source: 'website-quote', createdAt: '2026-10-01T12:00:00Z',
    updatedAt: '2026-10-01T12:00:00Z', currentPolicyExpiration: '2027-01-01', unitCount: 20,
  }));
  h.records = {
    Account: accounts,
    Contact: accounts.map(a => ({ id: `contact-${a.id}`, accountId: a.id, name: `Contact ${a.id}`, email: 'fixture@example.test', isPrimary: true })),
    Policy: accounts.filter(a => a.stage === 'CLIENT').map(a => ({ id: `policy-${a.id}`, accountId: a.id, policyNumber: `POL-${a.id}`, status: 'ACTIVE', carrierId: 'carrier-1', premium: 10000, expirationDate: '2027-01-01', effectiveDate: '2026-01-01', lines: ['Property'] })),
    Quote: accounts.filter(a => a.stage === 'LEAD').flatMap(a => Array.from({ length: 2 }, (_, i) => ({ id: `quote-${a.id}-${i}`, accountId: a.id, status: 'QUOTED', carrierId: 'carrier-1', premium: 10000, commissionPct: 10, lines: ['Property'] }))),
    Carrier: [{ id: 'carrier-1', name: 'Fixture Mutual' }],
    Document: Array.from({ length: 12 }, (_, i) => ({ id: `document-${i}`, entityId: accountId, entityType: 'ACCOUNT', category: i < 2 ? 'ACORD_FORM' : 'OTHER', name: `fixture-${i}.pdf`, s3Key: `documents/ACCOUNT/${accountId}/d${i}/fixture.pdf`, contentType: 'application/pdf', ocrStatus: 'COMPLETE', ocrText: 'Synthetic OCR evidence. '.repeat(1000), createdAt: '2026-10-01T12:00:00Z' })),
    Activity: [], Building: [], Loss: [], UserProfile: [], Certificate: [],
  };
  for (const model of Object.keys(h.records)) {
    h.models[model] = {
      list: vi.fn((args?: Record<string, unknown>) => modelList(model, 'list', args)),
      get: vi.fn(({ id }: { id: string }) => service(`${model}.get`, { data: h.records[model].find(row => row.id === id) ?? null }, 1)),
    };
  }
  h.models.Document.listDocumentByEntityId = vi.fn((args, options) => modelList('Document', 'listDocumentByEntityId', args, options));
  h.models.Activity.listActivityByEntityIdAndOccurredAt = vi.fn((args, options) => modelList('Activity', 'listActivityByEntityIdAndOccurredAt', args, options));
  h.models.UserProfile.listUserProfileByUserId = vi.fn((args, options) => modelList('UserProfile', 'listUserProfileByUserId', args, options));
  h.request.mockImplementation((operation: string, input: Record<string, unknown> = {}) => {
    if (operation === 'team' || operation === 'teamDirectory') return service(`communication.${operation}`, { team, actorId: 'alice' }, team.length);
    if (operation === 'commercialTable') { const items = (input.accountIds as string[]).map(commercialEntry); return service(`communication.${operation}`, { items }, items.length); }
    if (operation === 'context') return service('communication.context', { workflow: { accountId: input.accountId, name: 'Fixture Association 0000', salespersonId: 'alice', version: 1, disposition: 'BOUND' }, communications: [], team, issues: [], snooze: null }, 1);
    if (operation === 'relationshipContext') return service('communication.relationshipContext', { relationships: [], version: 0 }, 0);
    if (operation === 'accountListPage') {
      const rows = h.records.Account.filter(a => a.stage === input.stage && (!input.state || a.state === input.state));
      const items = rows.map(account => {
        const id = String(account.id), commercial = commercialEntry(id);
        return { account, contact: h.records.Contact.find(contact => contact.accountId === id),
          renewalDate: account.currentPolicyExpiration ?? null, commercial,
          forecast: pendingCommission(commercial.plan, h.records.Quote.filter(q => q.accountId === id) as unknown as PackageQuote[], '2026-11-04') };
      });
      items.sort((a, b) => String(a.account.name).localeCompare(String(b.account.name)));
      if (input.dir === 'desc') items.reverse();
      const start = Number(input.nextToken ?? 0), limit = Number(input.limit ?? 50), selected = items.slice(start, start + limit);
      return service('communication.accountListPage', { ready: true, items: selected,
        nextToken: start + limit < items.length ? String(start + limit) : undefined,
        asOf: '2026-11-04T12:00:00Z' }, selected.length);
    }
    if (operation === 'accountListCounts') {
      const total = h.records.Account.filter(a => a.stage === input.stage && (!input.state || a.state === input.state)).length;
      // The real endpoint bounds each response to four 50-candidate query
      // pages. All fixture rows match, so 300 matching rows require two calls.
      const offset = Number(input.nextToken ?? 0), count = Math.min(200, total - offset);
      return service('communication.accountListCounts', { ready: true, counts: { active: input.stage === 'LEAD' ? count : 0, snoozed: 0, due: 0, all: count },
        nextToken: offset + count < total ? String(offset + count) : undefined });
    }
    throw new Error(`Unexpected benchmark operation ${operation}`);
  });
}
async function settle(ready: () => boolean, untilReady = false) {
  let stable = 0, previousCalls = -1, firstContentMs: number | null = ready() ? Date.now() - h.epoch : null;
  if (untilReady && firstContentMs !== null) return firstContentMs;
  for (let step = 0; step < 2000; step++) {
    await act(async () => { await vi.advanceTimersByTimeAsync(5); });
    if (firstContentMs === null && ready()) firstContentMs = Date.now() - h.epoch;
    if (untilReady && firstContentMs !== null) return firstContentMs;
    if (h.pending === 0 && h.calls.length === previousCalls) stable++; else stable = 0;
    previousCalls = h.calls.length;
    if (stable >= 1) return firstContentMs;
  }
  throw new Error('Benchmark did not settle');
}
function capture(flow: string, startIndex: number, startMs: number, firstContentMs: number | null) {
  const calls = h.calls.slice(startIndex);
  const counts = Object.fromEntries([...new Set(calls.map(call => call.operation))].sort().map(operation => [operation, calls.filter(call => call.operation === operation).length]));
  report.push({ flow, role: h.role, fixtureAccounts: h.fixtureSize, injectedServiceDelayMs: delayMs,
    requests: calls.length, rowsTransferred: calls.reduce((n, call) => n + call.rows, 0),
    responseBytes: calls.reduce((n, call) => n + call.bytes, 0),
    firstContentMs: firstContentMs === null ? null : firstContentMs - startMs,
    requestsStartedBeforeFirstContent: firstContentMs === null ? null : calls.filter(call => call.startMs < firstContentMs).length,
    waterfallMs: Math.max(0, ...calls.map(call => call.endMs - startMs)), counts,
    renderedTableRows: screen.queryAllByRole('row').length, calls: calls.map(call => ({ ...call, startMs: call.startMs - startMs, endMs: call.endMs - startMs })) });
}
function wrapper(children: React.ReactNode) {
  return <AdminContext.Provider value={h.role === 'ADMIN'}><MemoryRouter>{children}</MemoryRouter></AdminContext.Provider>;
}
describe.skipIf(!enabled)('deterministic CRM performance flow audit', () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-04T12:00:00Z'));
    h.epoch = Date.now(); h.pending = 0; h.calls = []; h.role = 'ADMIN';
    h.fixtureSize = Number(process.env.CRM_PERF_ACCOUNTS ?? 600); h.request.mockReset(); h.saveReport.mockReset(); fixture();
  });
  afterAll(() => {
    if (enabled && process.env.CRM_PERF_REPORT) writeFileSync(process.env.CRM_PERF_REPORT, JSON.stringify({
      kind: 'deterministic-fixture-waterfall', warning: 'Injected delays and synthetic fixtures; not production AWS or browser latency. Response bytes count UTF-8 JSON payloads without transport headers. First content is sampled every 5 synthetic ms.',
      revision: process.env.CRM_PERF_REVISION ?? 'working-tree', results: report,
    }, null, 2) + '\n');
    vi.useRealTimers();
  });
  it.each(['LEAD', 'CLIENT'] as const)('measures %s cold entry and warm return', async stage => {
    function Page({ show = true }: { show?: boolean }) { return wrapper(<AccountsListDataProvider>{show && <AccountsList stage={stage} viewScope="audit:ADMIN" />}</AccountsListDataProvider>); }
    const ready = () => screen.queryAllByText(/Fixture Association/).length > 0;
    const page = render(<Page />); const coldContent = await settle(ready);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getAllByText(/Fixture Association/).length).toBeGreaterThan(0);
    capture(`${stage.toLowerCase()}-list-cold`, 0, 0, coldContent);
    page.rerender(<Page show={false} />); const startIndex = h.calls.length, startMs = Date.now() - h.epoch;
    page.rerender(<Page />); const warmContent = await settle(ready);
    expect(screen.getAllByText(/Fixture Association/).length).toBeGreaterThan(0);
    capture(`${stage.toLowerCase()}-list-warm-return`, startIndex, startMs, warmContent); cleanup();
  });
  it.each(['LEAD', 'CLIENT'] as const)('measures %s complete displayed-list traversal', async stage => {
    render(wrapper(<AccountsListDataProvider><AccountsList stage={stage} viewScope="audit:ADMIN" /></AccountsListDataProvider>));
    const ready = () => screen.queryAllByText(/Fixture Association/).length > 0;
    const content = await settle(ready, true);
    for (let step = 0; step < 100; step++) {
      const more = screen.queryByRole('button', { name: `Load more ${stage === 'LEAD' ? 'leads' : 'clients'}` });
      if (!more) break;
      const previousRows = screen.queryAllByText(/Fixture Association/).length;
      fireEvent.click(more); await settle(() => screen.queryAllByText(/Fixture Association/).length > previousRows, true);
      if (step === 99) throw new Error('List traversal did not terminate');
    }
    await settle(ready);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getAllByText(/Fixture Association/)).toHaveLength(h.fixtureSize / 2);
    capture(`${stage.toLowerCase()}-list-all-pages`, 0, 0, content); cleanup();
  }, 20_000);
  it.each(['LEAD', 'CLIENT'] as const)('measures %s full filtered export without requiring prior list traversal', async stage => {
    render(wrapper(<AccountsListDataProvider><AccountsList stage={stage} viewScope="audit:ADMIN" /></AccountsListDataProvider>));
    const ready = () => screen.queryAllByText(/Fixture Association/).length > 0;
    const content = await settle(ready);
    fireEvent.change(screen.getByRole('combobox', { name: `Download ${stage === 'LEAD' ? 'Leads' : 'Clients'}` }), { target: { value: 'csv' } });
    await settle(() => h.saveReport.mock.calls.length > 0);
    expect(h.saveReport).toHaveBeenCalledTimes(1);
    expect(h.saveReport.mock.calls[0][0].sections[0].rows).toHaveLength(h.fixtureSize / 2);
    capture(`${stage.toLowerCase()}-list-cold-then-export-all`, 0, 0, content); cleanup();
  });
  it.each(['overview', 'policies', 'documents'] as const)('measures account %s entry', async tab => {
    render(<AdminContext.Provider value><MemoryRouter initialEntries={[`/accounts/${accountId}?tab=${tab}`]}><Routes><Route path="/accounts/:id" element={<AccountDetail profile={{ id: 'profile-alice', userId: 'alice' } as never} />} /></Routes></MemoryRouter></AdminContext.Provider>);
    const content = await settle(() => tab === 'overview' ? screen.queryAllByText('Contact a0000').length > 0 : tab === 'policies' ? screen.queryByText('POL-a0000') !== null : screen.queryByText('fixture-11.pdf') !== null);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Fixture Association 0000');
    capture(`account-${tab}-cold`, 0, 0, content); cleanup();
  });
  it('measures communications context entry', async () => {
    render(wrapper(<LeadWorkflowPanel accountId={accountId} />)); const content = await settle(() => screen.queryByText('No linked communication yet.') !== null);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('No linked communication yet.')).toBeInTheDocument();
    capture('communications-context-cold', 0, 0, content); cleanup();
  });
});
