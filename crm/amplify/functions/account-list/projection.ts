import { createHash } from 'node:crypto';
import {
  ACCOUNT_LIST_SORTS, ACCOUNT_LIST_VERSION, accountListPartition, accountListRevision, accountListScope, accountListSnapshotKey,
  type AccountListAccount, type AccountListContact, type AccountListDependency, type AccountListIndex, type AccountListItem, type AccountListSnapshot, type AccountListStage,
} from '../../../../shared/accountList';
import { accountListSortKey, accountListSortValue } from '../../../../shared/accountListProjection';
import { emptyCommercialPlan, pendingCommission, type CommercialPlan, type PackageQuote } from '../../../../shared/quotePackages';
import { emptyLeadSnooze, type LeadSnooze } from '../../../../shared/leadSnooze';
import { currentContacts } from '../../../src/lib/contacts';
import { US_STATE_NAMES } from '../../../src/lib/usMap';

type RecordData = Record<string, unknown>;
export interface ProjectionSource {
  account?: RecordData; contacts: RecordData[]; quotes: RecordData[]; policies: RecordData[];
  communication: Map<string, RecordData>; profile?: RecordData;
}
export interface StoredAccountListSnapshot extends AccountListSnapshot { indexKeys: { pk: string; sk: string }[]; obsoleteKeys?: { pk: string; sk: string }[] }
const pick = (row: RecordData, fields: readonly string[]) => Object.fromEntries(fields.filter(field => row[field] !== undefined).map(field => [field, row[field]]));
const data = (row: RecordData | undefined) => row?.data as RecordData | undefined;
const text = (value: unknown) => typeof value === 'string' ? value : '';
const accountStateCode = (value: string | null | undefined) => {
  const state = value?.trim().toUpperCase();
  return state ? Object.keys(US_STATE_NAMES).find(code => code === state || US_STATE_NAMES[code].toUpperCase() === state) ?? '' : '';
};

/** Pure derivation: source records stay private; only allowlisted row fields
 * and the estimated opportunity editor's minimal plan cross into the index. */
export function buildAccountListProjection(accountId: string, source: ProjectionSource, today: string, builtAt: string) {
  if (!source.account || source.communication.has(`deleted-account:${accountId}`)) return;
  if (!['LEAD', 'CLIENT'].includes(String(source.account.stage))) return;
  const account = pick(source.account, ['id', 'name', 'stage', 'type', 'city', 'state', 'unitCount', 'totalInsuredValue', 'leadSource', 'source', 'createdAt', 'updatedAt', 'currentPolicyExpiration']) as unknown as AccountListAccount;
  const workflow = source.communication.get(`workflow:${accountId}`), storedPlan = source.communication.get(`commercial:${accountId}`), storedSnooze = source.communication.get(`lead-snooze:${accountId}`);
  const plan = storedPlan ? { ...data(storedPlan), version: storedPlan.version } as unknown as CommercialPlan : emptyCommercialPlan(accountId);
  const salespersonId = text(data(workflow)?.salespersonId) || undefined;
  const current = currentContacts(source.contacts.filter(row => row.accountId === accountId) as unknown as AccountListContact[], today);
  const selectedContact = current.find(contact => contact.isPrimary) ?? current[0];
  const contact = selectedContact ? pick(selectedContact as unknown as RecordData, ['id', 'accountId', 'name', 'email', 'isPrimary', 'validFrom', 'validUntil']) as unknown as AccountListContact : undefined;
  const renewalDate = source.policies.filter(policy => policy.accountId === accountId && policy.status === 'ACTIVE' && typeof policy.expirationDate === 'string')
    .map(policy => String(policy.expirationDate)).sort()[0] ?? null;
  const item: AccountListItem = {
    account, ...(contact ? { contact } : {}), renewalDate,
    commercial: { accountId, salespersonId, workflowVersion: Number(workflow?.version ?? 0),
      disposition: data(workflow)?.disposition as AccountListItem['commercial']['disposition'],
      plan: { ...emptyCommercialPlan(accountId), version: plan.version, estimatedCents: plan.estimatedCents },
      ...(account.stage === 'LEAD' ? { snooze: storedSnooze ? { ...data(storedSnooze), version: storedSnooze.version } as unknown as LeadSnooze : emptyLeadSnooze(accountId) } : {}),
    },
    forecast: pendingCommission(plan, source.quotes.filter(quote => quote.accountId === accountId) as unknown as PackageQuote[], today),
  };
  const dependencies: AccountListDependency[] = [{ model: 'Account', id: accountId, revision: accountListRevision(source.account) }];
  for (const [model, records] of [['Contact', source.contacts], ['Quote', source.quotes], ['Policy', source.policies]] as const) {
    for (const record of records) dependencies.push({ model, id: text(record.id), revision: accountListRevision(record) });
  }
  for (const id of [`workflow:${accountId}`, `commercial:${accountId}`, `lead-snooze:${accountId}`, `deleted-account:${accountId}`, ...(salespersonId ? [`eligibility:${salespersonId}`] : [])]) {
    dependencies.push({ model: 'Communication', id, revision: accountListRevision(source.communication.get(id)) });
  }
  if (source.profile) dependencies.push({ model: 'UserProfile', id: text(source.profile.id), revision: accountListRevision(source.profile) });
  dependencies.sort((a, b) => `${a.model}:${a.id}`.localeCompare(`${b.model}:${b.id}`));
  const generation = createHash('sha256').update(JSON.stringify({ version: ACCOUNT_LIST_VERSION, today, item, dependencies })).digest('hex');
  const snapshot: StoredAccountListSnapshot = { ...accountListSnapshotKey(accountId), accountId, generation, version: ACCOUNT_LIST_VERSION, builtAt, item, dependencies, indexKeys: [] };
  const salespersonName = source.profile ? `${text(source.profile.firstName)} ${text(source.profile.lastName)}`.trim() || text(source.profile.email) : undefined;
  const stages: AccountListStage[] = account.stage === 'LEAD' ? ['LEAD'] : item.forecast.unfinished ? ['LEAD', 'CLIENT'] : ['CLIENT'];
  const indexes: AccountListIndex[] = [];
  for (const scope of [accountListScope(), ...(salespersonId ? [accountListScope(salespersonId)] : [])]) for (const stage of stages) for (const sort of ACCOUNT_LIST_SORTS) {
    const key = accountListSortKey(accountListSortValue(item, sort, stage, salespersonName), accountId);
    const index: AccountListIndex = { pk: accountListPartition(scope, stage, sort, key.missing), sk: key.sk, accountId, generation, stage,
      state: accountStateCode(account.state), salespersonId: salespersonId ?? '',
      open: account.stage === 'CLIENT' || !['LOST', 'DISQUALIFIED', 'BOUND'].includes(item.commercial.disposition ?? ''),
      followUpOn: account.stage === 'LEAD' ? item.commercial.snooze?.followUpOn ?? '' : '' };
    indexes.push(index); snapshot.indexKeys.push({ pk: index.pk, sk: index.sk });
  }
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 350_000) throw new Error('Account list snapshot exceeds its safe storage limit');
  return { snapshot, indexes };
}
