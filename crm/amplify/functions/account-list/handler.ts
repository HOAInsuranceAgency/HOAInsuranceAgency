import type { DynamoDBStreamEvent } from 'aws-lambda';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ACCOUNT_LIST_VERSION } from '../../../../shared/accountList';
import { agencyDay } from '../../../../shared/leadActionGuidance';
import { drainNameRefresh, queueNameRefresh, db, projectAccount, projectionTable, readOne, sourceTables, writeControl, type SourceHints, type SourceModel } from './store';

type RecordData = Record<string, unknown>;
interface Checkpoint { day: string; cursor?: RecordData; complete?: boolean; processed?: number; completedAt?: string; pendingIds?: string[]; nextCursor?: RecordData }

/** A restarted or daily sweep withholds readiness until every account has
 * been rebuilt for the same agency day. Each completed page is checkpointed. */
export async function repairAccountList(options: { budgetMs?: number; maxPages?: number } = {}) {
  const today = agencyDay(new Date().toISOString());
  const previous = await readOne(projectionTable(), { pk: 'CONTROL', sk: 'BUILD' }) as unknown as Checkpoint | undefined;
  let checkpoint: Checkpoint = previous?.day === today && !previous.complete ? previous : { day: today, processed: 0 };
  const ready = await readOne(projectionTable(), { pk: 'CONTROL', sk: 'READY' });
  if (ready?.day !== today || ready.version !== ACCOUNT_LIST_VERSION) await writeControl('READY', { version: ACCOUNT_LIST_VERSION, day: today, complete: false });
  if (previous?.day === today && previous.complete && ready?.complete === true &&
      Date.now() - Date.parse(previous.completedAt ?? '') < 15 * 60_000) return;
  const deadline = Date.now() + (options.budgetMs ?? (ready?.day === today && ready.complete === true ? 10_000 : 45_000));
  for (let page = 0; page < (options.maxPages ?? 20) && Date.now() < deadline; page++) {
    const result = checkpoint.pendingIds ? { Items: checkpoint.pendingIds.map(id => ({ id })), LastEvaluatedKey: checkpoint.nextCursor } :
      await db.send(new ScanCommand({ TableName: sourceTables().Account, ConsistentRead: true, Limit: 25,
        ExclusiveStartKey: checkpoint.cursor, ProjectionExpression: '#id', ExpressionAttributeNames: { '#id': 'id' } }));
    const accounts = result.Items ?? [];
    for (let offset = 0; offset < accounts.length; offset += 4) {
      if (Date.now() >= deadline) return;
      const group = accounts.slice(offset, offset + 4);
      const results = await Promise.allSettled(group.map(account => projectAccount(String(account.id), today, new Date().toISOString())));
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      checkpoint = { ...checkpoint, complete: false, processed: (checkpoint.processed ?? 0) + group.length,
        pendingIds: accounts.slice(offset + group.length).map(account => String(account.id)), nextCursor: result.LastEvaluatedKey };
      await writeControl('BUILD', checkpoint as unknown as RecordData);
    }
    checkpoint = { day: today, cursor: result.LastEvaluatedKey, complete: !result.LastEvaluatedKey,
      ...(!result.LastEvaluatedKey ? { completedAt: new Date().toISOString() } : {}), processed: checkpoint.processed ?? 0 };
    await writeControl('BUILD', checkpoint as unknown as RecordData);
    if (checkpoint.complete) {
      await writeControl('READY', { version: ACCOUNT_LIST_VERSION, day: today, complete: true, builtAt: new Date().toISOString(), processed: checkpoint.processed });
      return;
    }
  }
}

const image = (value: Record<string, unknown> | undefined) => value ? unmarshall(value as Record<string, AttributeValue>) : undefined;
export async function handleAccountListStream(event: DynamoDBStreamEvent) {
  const models = sourceTables(), today = agencyDay(new Date().toISOString()), batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      const sourceName = record.eventSourceARN?.split(':table/')[1]?.split('/stream/')[0];
      const model = (Object.entries(models).find(([, name]) => name === sourceName)?.[0]) as SourceModel | undefined;
      if (!model) throw new Error('Unknown account list stream source');
      const before = image(record.dynamodb?.OldImage), after = image(record.dynamodb?.NewImage), values = [before, after].filter(Boolean) as RecordData[];
      const ids = new Set<string>(), hints: SourceHints = {};
      if (model === 'UserProfile' || model === 'Communication' && values.some(value => value.kind === 'ELIGIBILITY')) {
        const users = new Set(values.map(value => model === 'UserProfile' ? value.userId : (value.data as RecordData | undefined)?.userId));
        // A name change can affect thousands of assignments. Queue a durable
        // fan-out rather than restart the same serial prefix on stream timeout.
        const profileIds = model === 'UserProfile' ? values.map(value => String(value.id)) : [];
        for (const userId of users) if (typeof userId === 'string') await queueNameRefresh(userId, profileIds);
      } else if (model === 'Communication') {
        for (const value of values) {
          if (!['WORKFLOW', 'COMMERCIAL_PLAN', 'LEAD_SNOOZE'].includes(String(value.kind)) && !String(value.id).startsWith('deleted-account:')) continue;
          const id = value.accountId ?? (value.data as RecordData | undefined)?.accountId ?? String(value.id).split(':')[1];
          if (typeof id === 'string' && id) ids.add(id);
        }
      } else for (const value of values) {
        const id = model === 'Account' ? value.id : value.accountId;
        if (typeof id === 'string' && id) ids.add(id);
        hints[model] = values.map(value => String(value.id));
      }
      for (const id of ids) await projectAccount(id, today, new Date().toISOString(), hints);
    } catch (error) {
      // An incomplete projection must not masquerade as a complete directory.
      await writeControl('READY', { version: ACCOUNT_LIST_VERSION, day: today, complete: false });
      await writeControl('BUILD', { day: today, complete: false, processed: 0 });
      console.error('Account list projection failed', { eventID: record.eventID, error });
      batchItemFailures.push({ itemIdentifier: record.dynamodb?.SequenceNumber ?? record.eventID! });
    }
  }
  return { batchItemFailures };
}
export async function handler(event: DynamoDBStreamEvent | RecordData) {
  if (process.env.HOA_MIGRATION_PREVIEW === 'true' || process.env.HOA_MIGRATION_WORKERS_ENABLED === 'false') return { batchItemFailures: [] };
  if (Array.isArray(event.Records)) return handleAccountListStream(event as DynamoDBStreamEvent);
  try { await drainNameRefresh({ budgetMs: 10_000 }); await repairAccountList(); }
  catch (error) {
    const day = agencyDay(new Date().toISOString());
    await writeControl('READY', { version: ACCOUNT_LIST_VERSION, day, complete: false });
    await writeControl('BUILD', { day, complete: false, processed: 0 });
    throw error;
  }
  return { ok: true };
}
