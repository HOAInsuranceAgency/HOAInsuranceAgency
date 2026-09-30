import type { LeadWorkflow } from '../../../../shared/leadWorkflow';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { dataClient } from './data';
import { accountRows } from './workflow';
import { audit, canonical, commit, db, get, put, query, row, save, type Row } from './store';
import type { Operation } from './operations';

/** Amplify's lazy hasMany methods use filtered table lists: an empty page can
 * still have a cursor for unrelated accounts. Query this account's existing
 * relation index instead, stopping at the first actual matching record. */
async function hasAccountRecords(accountId: string, model: 'POLICY' | 'INVOICE') {
  const label = model === 'POLICY' ? 'policies' : 'billing records';
  try {
    const table = process.env[`LEAD_DELETION_${model}_TABLE`];
    const index = process.env[`LEAD_DELETION_${model}_INDEX`];
    if (!table || !index) throw new Error('Missing deletion lookup configuration');
    let cursor: Record<string, unknown> | undefined;
    const seen = new Set<string>();
    do {
      const page = await db.send(new QueryCommand({
        TableName: table, IndexName: index,
        KeyConditionExpression: '#accountId = :accountId',
        ExpressionAttributeNames: { '#accountId': 'accountId' },
        ExpressionAttributeValues: { ':accountId': accountId },
        Select: 'COUNT', Limit: 1,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }));
      if (typeof page.Count !== 'number' || !Number.isInteger(page.Count) || page.Count < 0 || page.Count > 1) throw new Error('Incomplete deletion lookup');
      if (page.Count > 0) return true;
      cursor = page.LastEvaluatedKey && Object.keys(page.LastEvaluatedKey).length ? page.LastEvaluatedKey : undefined;
      if (cursor) {
        const token = canonical(cursor);
        if (seen.has(token)) throw new Error('Deletion lookup did not advance');
        seen.add(token);
      }
    } while (cursor);
    return false;
  } catch {
    throw new Error(`Could not verify this lead's ${label}. Refresh and try again.`);
  }
}

const phases = [
  'TASK',
  'OPERATION',
  'NOTIFICATION',
  'ISSUE',
  'LINK',
  'COMMERCIAL_PLAN',
  'ROLE_SYNC',
];
export async function prepareLeadDeletion(
  accountId: string,
  name: string,
  actor: string,
) {
  const account = await (
    await dataClient()
  ).models.Account.get({ id: accountId });
  if (
    account.errors?.length ||
    !account.data ||
    account.data.stage !== 'LEAD' ||
    account.data.name !== name
  )
    throw new Error('Refresh and confirm the lead before deleting');
  if (await hasAccountRecords(accountId, 'POLICY'))
    throw new Error('An account with policies cannot be deleted as a lead');
  if (await hasAccountRecords(accountId, 'INVOICE'))
    throw new Error(
      'An account with billing records cannot be deleted as a test lead',
    );
  const pending = await accountRows<Operation>(accountId, 'OPERATION');
  if (
    pending.some((r) =>
      ['LEASED', 'ACCEPTED', 'UNKNOWN'].includes(r.data.state),
    )
  )
    throw new Error(
      'A delivery is in progress or needs review. Resolve it before deleting this lead.',
    );
  await retireAccount(accountId, actor);
}
/** A durable tombstone prevents stale queued work from sending or recreating reminders. */
export async function retireAccount(accountId: string, actor: string) {
  const id = `deleted-account:${accountId}`,
    old = await get(id);
  if (!old) {
    const wf = await get<LeadWorkflow>(`workflow:${accountId}`),
      at = new Date().toISOString();
    await commit([
      put(row('DELETED_ACCOUNT', id, { accountId, at, actor })),
      ...(wf
        ? [
            put(
              row(
                'WORKFLOW',
                wf.id,
                {
                  ...wf.data,
                  disposition: 'DISQUALIFIED',
                  humanTakeover: true,
                  version: wf.version + 1,
                },
                { accountId, previous: wf },
              ),
              wf,
            ),
          ]
        : []),
      put(
        row(
          'ACCOUNT_DELETE',
          `account-delete:${accountId}`,
          { accountId, phase: 0 },
          { accountId, dueAt: at },
        ),
      ),
      audit(
        accountId,
        actor,
        'Lead deletion started; automated work retired',
        {},
      ),
    ]);
  }
  const job = await get<{ accountId: string; phase: number; cursor?: string }>(
    `account-delete:${accountId}`,
  );
  if (job?.dueAt) await retireAccountPage(job);
}
export async function retireAccountPage(
  candidate: Row<{ accountId: string; phase: number; cursor?: string }>,
) {
  const job = await get<typeof candidate.data>(candidate.id);
  if (!job?.dueAt) return;
  const { accountId, phase, cursor } = job.data,
    kind = phases[phase];
  const page = await query('account', accountId, cursor, 25, `${kind}#`);
  // Fresh row versions fence concurrent completion; the next tick resumes a conflict.
  for (const candidate of page.items) {
    const old = await get(candidate.id);
    if (!old) continue;
    // Preserve the recovery path for any delivery already accepted or in flight.
    if (
      kind === 'OPERATION' &&
      ['LEASED', 'ACCEPTED', 'UNKNOWN'].includes(String(old.data.state))
    )
      continue;
    if (kind === 'ISSUE' && old.data.sourceId) {
      const op = await get<Operation>(String(old.data.sourceId));
      if (
        op?.kind === 'OPERATION' &&
        ['LEASED', 'ACCEPTED', 'UNKNOWN'].includes(op.data.state)
      )
        continue;
    }
    if (["TASK", "NOTIFICATION"].includes(kind)) {
      const { dueAt: _dueAt, dueGroup: _dueGroup, workAt: _workAt, workKind: _workKind, ...historical } = old;
      await save({ ...historical, version: old.version + 1, updatedAt: new Date().toISOString() }, old);
      continue;
    }
    const data =
      kind === 'TASK'
        ? {
            ...old.data,
            status: 'CANCELLED',
            reason: 'Lead deleted',
            version: old.version + 1,
          }
        : kind === 'OPERATION'
          ? {
              ...old.data,
              state: ['CONFIRMED', 'UNKNOWN'].includes(String(old.data.state))
                ? old.data.state
                : 'SUPPRESSED',
              error: 'Lead deleted',
            }
          : kind === 'LINK'
            ? { ...old.data, accountId: '', formerAccountId: accountId }
            : { ...old.data, resolved: true, resolution: 'Lead deleted' };
    if (kind === 'TASK' && old.data.status !== 'OPEN') continue;
    await save(
      row(kind === 'COMMERCIAL_PLAN' ? 'ARCHIVED_PLAN' : kind, old.id, data, {
        accountId,
        previous: old,
      }),
      old,
    );
  }
  const nextPhase = page.nextToken ? phase : phase + 1;
  await save(
    row(
      'ACCOUNT_DELETE',
      job.id,
      { accountId, phase: nextPhase, cursor: page.nextToken },
      {
        accountId,
        previous: job,
        dueAt: nextPhase < phases.length ? new Date().toISOString() : undefined,
      },
    ),
    job,
  );
}
