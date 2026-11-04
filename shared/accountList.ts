import type { CommercialPlan } from './quotePackages';
import type { LeadSnooze } from './leadSnooze';
import type { LeadWorkflow } from './leadWorkflow';

export const ACCOUNT_LIST_VERSION = 1;
export const ACCOUNT_LIST_SORTS = ['name', 'type', 'contact', 'city', 'state', 'salesperson', 'source', 'form', 'estimate', 'pending', 'units', 'tiv', 'entered', 'renewal', 'followUp'] as const;
export type AccountListSort = typeof ACCOUNT_LIST_SORTS[number];
export type AccountListStage = 'LEAD' | 'CLIENT';
export type AccountListView = 'active' | 'snoozed' | 'due' | 'all';
export interface AccountListAccount {
  id: string; name: string; stage: AccountListStage; type: 'ASSOCIATION' | 'PERSONAL' | 'COMMERCIAL_OTHER';
  city?: string | null; state?: string | null; unitCount?: number | null; totalInsuredValue?: number | null;
  leadSource?: string | null; source?: string | null; createdAt?: string | null; updatedAt?: string | null;
  currentPolicyExpiration?: string | null;
}
export interface AccountListContact {
  id: string; accountId: string; name: string; email?: string | null;
  isPrimary?: boolean | null; validFrom?: string | null; validUntil?: string | null;
}
export interface AccountListEntry {
  accountId: string; plan: CommercialPlan; salespersonId?: string; workflowVersion?: number;
  disposition?: LeadWorkflow['disposition']; snooze?: LeadSnooze;
}
export interface AccountListItem {
  account: AccountListAccount; contact?: AccountListContact; renewalDate: string | null;
  commercial: AccountListEntry;
  forecast: { cents: number | null; label: string; unfinished: boolean; optionId?: string };
}
export interface AccountListRequest {
  stage: AccountListStage; view: AccountListView; state?: string; salespersonId?: string;
  sort: AccountListSort; dir: 'asc' | 'desc'; limit?: number; nextToken?: string;
}
export interface AccountListPage { ready: boolean; items: AccountListItem[]; nextToken?: string; asOf?: string }
export interface AccountListCounts {
  ready: boolean; counts: Record<AccountListView, number>; nextToken?: string;
}
/** Source versions fence stale materialized children before they cross an access boundary. */
export interface AccountListDependency { model: 'Account' | 'Contact' | 'Quote' | 'Policy' | 'UserProfile' | 'Communication'; id: string; revision: string }
export interface AccountListSnapshot {
  pk: string; sk: 'SNAPSHOT'; accountId: string; generation: string; version: number; builtAt: string;
  item: AccountListItem; dependencies: AccountListDependency[];
}
export interface AccountListIndex {
  pk: string; sk: string; accountId: string; generation: string; stage: AccountListStage;
  state: string; salespersonId: string; open: boolean; followUpOn: string;
}
export const accountListScope = (salespersonId?: string) => salespersonId ? `USER#${salespersonId}` : 'AGENCY';
export const accountListPartition = (scope: string, stage: AccountListStage, sort: AccountListSort, missing = false) => `V${ACCOUNT_LIST_VERSION}#${scope}#${stage}#${sort}#${missing ? 'MISSING' : 'VALUE'}`;
export const accountListSnapshotKey = (accountId: string) => ({ pk: `ACCOUNT#${accountId}`, sk: 'SNAPSHOT' as const });
export const accountListRevision = (record: Record<string, unknown> | undefined) => record ? String(record.version ?? record.updatedAt ?? '') : '-';
export function accountListMatches(row: Pick<AccountListIndex, 'open' | 'followUpOn'>, view: AccountListView, today: string) {
  if (view === 'all') return true;
  if (!row.open) return false;
  if (view === 'snoozed') return row.followUpOn > today;
  if (view === 'due') return !!row.followUpOn && row.followUpOn <= today;
  return !row.followUpOn || row.followUpOn <= today;
}
