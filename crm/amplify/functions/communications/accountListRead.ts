import { BatchGetCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { createHash } from 'node:crypto';
import {
  ACCOUNT_LIST_SORTS, ACCOUNT_LIST_VERSION, accountListMatches, accountListPartition,
  accountListRevision, accountListScope, accountListSnapshotKey,
  type AccountListCounts, type AccountListIndex, type AccountListItem, type AccountListPage,
  type AccountListRequest, type AccountListSnapshot,
} from '../../../../shared/accountList';
import { agencyDay } from '../../../../shared/leadActionGuidance';
import { AccountAccess } from '../crm-access/access';
import { activeRole, type RoleRequest } from '../crm-access/active-role';
import { AccessDenied, type Identity, type RecordData } from '../crm-access/policy';
import { db } from './store';

type Cursor = { version: number; scope: string; missing: boolean; key?: { pk: string; sk: string } };
const failCursor = () => new Error('Start this account view again; its pagination token is invalid or expired.');
class ProjectionNeedsFallback extends Error {}
function request(raw: RecordData, admin: boolean, actor: string): AccountListRequest {
  if (!['LEAD', 'CLIENT'].includes(String(raw.stage)) || !['active', 'snoozed', 'due', 'all'].includes(String(raw.view)) ||
      !ACCOUNT_LIST_SORTS.includes(raw.sort as AccountListRequest['sort']) || !['asc', 'desc'].includes(String(raw.dir))) throw new Error('Choose a valid account view.');
  if (raw.state !== undefined && (typeof raw.state !== 'string' || !/^$|^[A-Z]{2}$/.test(raw.state))) throw new Error('Choose a valid state.');
  if (raw.salespersonId !== undefined && (typeof raw.salespersonId !== 'string' || !/^$|^[a-zA-Z0-9_-]{1,128}$/.test(raw.salespersonId))) throw new Error('Choose a valid salesperson.');
  if (!admin && raw.salespersonId && raw.salespersonId !== actor) throw new AccessDenied();
  const limit = raw.limit ?? 25;
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 50) throw new Error('Choose 1 to 50 accounts per page.');
  return { stage: raw.stage as AccountListRequest['stage'], view: raw.stage === 'CLIENT' ? 'all' : raw.view as AccountListRequest['view'],
    sort: raw.sort as AccountListRequest['sort'], dir: raw.dir as 'asc' | 'desc', state: raw.state as string | undefined,
    salespersonId: admin ? raw.salespersonId as string | undefined : actor, limit: Number(limit), nextToken: raw.nextToken as string | undefined };
}
function cursor(raw: unknown, scope: string): Cursor {
  if (raw === undefined) return { version: ACCOUNT_LIST_VERSION, scope, missing: false };
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{1,6000}$/.test(raw)) throw failCursor();
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString()) as Cursor;
    if (c.version !== ACCOUNT_LIST_VERSION || c.scope !== scope || typeof c.missing !== 'boolean' ||
      c.key !== undefined && (!c.key || Object.keys(c.key).sort().join(',') !== 'pk,sk' || typeof c.key.pk !== 'string' || typeof c.key.sk !== 'string' || c.key.sk.length > 1600)) throw failCursor();
    return c;
  } catch { throw failCursor(); }
}
const encode = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');

/** Unprocessed keys and failed reads must never be interpreted as missing/access-denied records. */
async function batch(table: string, keys: RecordData[], model?: string) {
  if (!table) throw new Error('Account list storage is not configured.');
  const found = new Map<string, RecordData>();
  for (let offset = 0; offset < keys.length; offset += 100) {
    let pending = keys.slice(offset, offset + 100);
    for (let attempt = 0; pending.length; attempt++) {
      const result = await db.send(new BatchGetCommand({ RequestItems: { [table]: { Keys: pending, ConsistentRead: true,
        ...(model ? model === 'Communication'
          ? { ProjectionExpression: '#id, #version, #data.salespersonId', ExpressionAttributeNames: { '#id': 'id', '#version': 'version', '#data': 'data' } }
          : { ProjectionExpression: '#id, updatedAt, accountId', ExpressionAttributeNames: { '#id': 'id' } } : {}) } } }));
      for (const row of result.Responses?.[table] ?? []) found.set(String(row.id ?? row.pk), row);
      pending = result.UnprocessedKeys?.[table]?.Keys ?? [];
      if (pending.length) {
        if (attempt === 3) throw new Error('Account details are busy. Refresh to try again.');
        await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt));
      }
    }
  }
  return found;
}

/** A projection is only a candidate. Fresh source versions and canonical child
 * account IDs are checked on every response, including administrator reads. */
export async function validatedAccountListItems(index: AccountListIndex[], access: AccountAccess) {
  if (!index.length) return [];
  const snapshots = await batch(process.env.ACCOUNT_LIST_TABLE!, [...new Set(index.map(row => row.accountId))].map(accountListSnapshotKey));
  const candidates = index.flatMap(entry => {
    const snapshot = snapshots.get(`ACCOUNT#${entry.accountId}`) as unknown as AccountListSnapshot | undefined;
    return snapshot?.version === ACCOUNT_LIST_VERSION && snapshot.generation === entry.generation && snapshot.accountId === entry.accountId &&
      snapshot.item.account.id === entry.accountId && agencyDay(snapshot.builtAt) === agencyDay(new Date().toISOString()) ? [{ entry, snapshot }] : [];
  });
  const keys = new Map<string, Set<string>>();
  if (candidates.some(({ snapshot }) => !Array.isArray(snapshot.dependencies) || snapshot.dependencies.length > 256)) throw new ProjectionNeedsFallback();
  for (const { snapshot } of candidates) for (const dep of snapshot.dependencies) {
    if (!['Account', 'Contact', 'Quote', 'Policy', 'UserProfile', 'Communication'].includes(dep.model) || typeof dep.id !== 'string' || !dep.id || dep.id.length > 256 || typeof dep.revision !== 'string' || !dep.revision) throw new Error('Account list projection needs rebuilding.');
    const ids = keys.get(dep.model) ?? new Set<string>(); ids.add(dep.id); keys.set(dep.model, ids);
  }
  if ([...keys.values()].reduce((total, ids) => total + ids.size, 0) > 2000) throw new ProjectionNeedsFallback();
  const sourceTables = JSON.parse(process.env.ACCOUNT_LIST_SOURCE_TABLES ?? '{}') as Record<string, string>;
  const current = new Map(await Promise.all([...keys].map(async ([model, ids]) => [model,
    await batch(sourceTables[model], [...ids].map(id => ({ id })), model),
  ] as const)));
  const items: AccountListItem[] = [];
  for (const { entry, snapshot } of candidates) {
    const requiredCommunication = ['workflow', 'commercial', 'lead-snooze', 'deleted-account'].map(kind => `${kind}:${entry.accountId}`);
    if (!current.get('Account')?.has(entry.accountId) ||
        snapshot.item.contact && !current.get('Contact')?.has(snapshot.item.contact.id) ||
        !snapshot.dependencies.some(dep => dep.model === 'Account' && dep.id === entry.accountId) ||
        requiredCommunication.some(key => !snapshot.dependencies.some(dep => dep.model === 'Communication' && dep.id === key)) ||
        snapshot.item.commercial.accountId !== entry.accountId || snapshot.item.commercial.plan.accountId !== entry.accountId ||
        snapshot.item.contact && (snapshot.item.contact.accountId !== entry.accountId || !snapshot.dependencies.some(dep => dep.model === 'Contact' && dep.id === snapshot.item.contact!.id))) continue;
    const workflow = current.get('Communication')?.get(`workflow:${entry.accountId}`);
    if (current.get('Communication')?.has(`deleted-account:${entry.accountId}`)) continue;
    if (!access.admin && (workflow?.data as RecordData | undefined)?.salespersonId !== access.actor) continue;
    const valid = snapshot.dependencies.every(dep => {
      const source = current.get(dep.model)?.get(dep.id);
      if (accountListRevision(source) !== dep.revision) return false;
      if (source && ['Contact', 'Quote', 'Policy'].includes(dep.model) && source.accountId !== entry.accountId) return false;
      return true;
    });
    if (!valid) throw new ProjectionNeedsFallback();
    items.push(snapshot.item);
  }
  return items;
}

export async function accountListRead(raw: RecordData, identity: Identity | undefined, headers?: RoleRequest, countsOnly = false): Promise<AccountListPage | AccountListCounts> {
  const access = new AccountAccess(identity, undefined, headers);
  const input = request(raw, access.admin, access.actor), today = agencyDay(new Date().toISOString());
  const scope = createHash('sha256').update(JSON.stringify({ actor: access.actor, role: activeRole(identity, headers),
    ...input, nextToken: undefined, today, countsOnly })).digest('hex');
  const c = cursor(raw.nextToken, scope), TableName = process.env.ACCOUNT_LIST_TABLE;
  const counts = { active: 0, snoozed: 0, due: 0, all: 0 };
  if (!TableName) return countsOnly ? { ready: false, counts } : { ready: false, items: [] };
  const ready = (await db.send(new GetCommand({ TableName, Key: { pk: 'CONTROL', sk: 'READY' }, ConsistentRead: true }))).Item;
  if (ready?.version !== ACCOUNT_LIST_VERSION || ready.complete !== true || ready.day !== today) return countsOnly ? { ready: false, counts } : { ready: false, items: [] };
  const items: AccountListItem[] = [];
  const partition = (missing: boolean) => accountListPartition(accountListScope(input.salespersonId), input.stage, countsOnly ? 'name' : input.sort, missing);
  if (c.key && c.key.pk !== partition(c.missing)) throw failCursor();
  let done = false;
  // Bounded evaluated candidates, including sparse filters and stale projections.
  // Never drain the full book before delivering the first page.
  for (let page = 0; page < (countsOnly ? 4 : 8); page++) {
    const limit = countsOnly ? 50 : Math.min(50, input.limit! - items.length);
    const response = await db.send(new QueryCommand({ TableName, ConsistentRead: true,
      KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': partition(c.missing) },
      ScanIndexForward: c.missing || input.dir === 'asc' || countsOnly, Limit: limit, ExclusiveStartKey: c.key,
    }));
    const index = (response.Items ?? []) as AccountListIndex[];
    if (index.some(row => row.pk !== partition(c.missing) || typeof row.sk !== 'string' || typeof row.accountId !== 'string')) throw new Error('Invalid account list page.');
    const matching = index.filter(row => (!input.state || row.state === input.state) &&
      (!input.salespersonId || row.salespersonId === input.salespersonId) &&
      (countsOnly || accountListMatches(row, input.view, today)));
    let valid: AccountListItem[];
    try { valid = await validatedAccountListItems(matching, access); }
    catch (error) { if (!(error instanceof ProjectionNeedsFallback)) throw error;
      return countsOnly ? { ready: false, counts: { active: 0, snoozed: 0, due: 0, all: 0 } } : { ready: false, items: [] };
    }
    if (countsOnly) {
      for (const item of valid) {
        const row = matching.find(row => row.accountId === item.account.id)!;
        for (const view of ['active', 'snoozed', 'due', 'all'] as const) if (accountListMatches(row, view, today)) counts[view]++;
      }
    } else items.push(...valid.map(item => input.stage === 'LEAD' ? { ...item, renewalDate: item.account.currentPolicyExpiration ?? null } : item));
    c.key = response.LastEvaluatedKey as Cursor['key'];
    if (!c.key) {
      if (c.missing) { done = true; break; }
      c.missing = true;
    }
    if (!countsOnly && items.length >= input.limit!) break;
  }
  const nextToken = done ? undefined : encode(c);
  return countsOnly ? { ready: true, counts, ...(nextToken ? { nextToken } : {}) }
    : { ready: true, items, ...(nextToken ? { nextToken } : {}), asOf: new Date().toISOString() };
}
