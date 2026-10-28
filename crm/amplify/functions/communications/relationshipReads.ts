import { BatchGetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { AccountAccess } from '../crm-access/access';
import type { Identity, RecordData } from '../crm-access/policy';
import type { RoleRequest } from '../crm-access/active-role';
import { agencyDay } from '../../../../shared/leadActionGuidance';
import { db, hash, canonical } from './store';
import { dataClient } from './data';

export { DIRECTORY_READS } from '../../../../shared/relationships';
const table = (model: string) => {
  const value = process.env[`${model.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}_TABLE`];
  if (!value) throw new Error('Relationship storage is not configured.');
  return value;
};
/** One bounded BatchGet per model, with bounded retries. Missing rows are cached too. */
export async function relationshipBatch(model: string, ids: string[]) {
  const keys = [...new Set(ids)];
  if (keys.length > 100) throw new Error('Choose up to 100 records.');
  const records = new Map<string, RecordData>();
  if (!keys.length) return records;
  const name = table(model);
  let pending: Record<string, { Keys: { id: string }[]; ConsistentRead?: boolean }> = {
    [name]: { Keys: keys.map((id) => ({ id })), ConsistentRead: true },
  };
  for (let attempt = 0; Object.keys(pending).length; attempt++) {
    if (attempt === 4) throw new Error('Relationship lookup is busy. Please retry.');
    const result = await db.send(new BatchGetCommand({ RequestItems: pending }));
    for (const record of result.Responses?.[name] ?? []) records.set(String(record.id), record);
    pending = (result.UnprocessedKeys as typeof pending) ?? {};
    if (Object.keys(pending).length) await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
  }
  return records;
}
const profile = (r: RecordData) =>
  Object.fromEntries(
    [
      'id',
      'kind',
      'name',
      'category',
      'email',
      'phone',
      'website',
      'ownerId',
      'notes',
      'archived',
      'revision',
      'createdAt',
      'updatedAt',
    ].map((k) => [k, r[k] ?? null]),
  );
export function relationshipCursor(
  input: unknown,
  scope: string,
): { key?: Record<string, string>; token?: string } {
  if (input == null) return {};
  try {
    if (typeof input !== 'string' || input.length > 24000) throw new Error();
    const cursor = JSON.parse(Buffer.from(input, 'base64url').toString());
    if (
      cursor.scope !== scope ||
      (cursor.token != null && typeof cursor.token !== 'string') ||
      (cursor.key != null &&
        (typeof cursor.key !== 'object' ||
          Array.isArray(cursor.key) ||
          Object.entries(cursor.key).some(([k, v]) => k !== 'id' || typeof v !== 'string' || v.length > 128)))
    )
      throw new Error();
    return cursor;
  } catch {
    throw new Error('Search changed. Start again.');
  }
}
export const relationshipToken = (scope: string, value: { key?: RecordData; token?: string | null }) =>
  value.key || value.token
    ? Buffer.from(JSON.stringify({ scope, ...value })).toString('base64url')
    : undefined;
async function visibleAccounts(ids: string[], identity: Identity, request?: RoleRequest) {
  const keys = [...new Set(ids)];
  const [accounts, workflow] = await Promise.all([
    relationshipBatch('Account', keys),
    relationshipBatch(
      'Communication',
      keys.flatMap((id) => [`workflow:${id}`, `deleted-account:${id}`]),
    ),
  ]);
  // Prime both kinds of lookup in batches; AccountAccess never does N+1 reads here.
  const access = new AccountAccess(
    identity,
    async (model, id) => (model === 'Account' ? accounts.get(id) : workflow.get(id)),
    request,
  );
  await access.prefetchAccounts(keys);
  const result = new Map<string, RecordData>();
  for (const [id, account] of accounts)
    if (!workflow.has(`deleted-account:${id}`) && (await access.canAccount(id)))
      result.set(id, { id, name: account.name, stage: account.stage });
  return result;
}
export async function relationshipRead(
  op: string,
  input: RecordData,
  identity: Identity,
  request?: RoleRequest,
) {
  const access = new AccountAccess(identity, undefined, request);
  if (op === 'relationshipProfiles') {
    if (
      !Array.isArray(input.ids) ||
      input.ids.length > 100 ||
      input.ids.some((id) => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id))
    )
      throw new Error('Choose up to 100 profiles.');
    return { items: [...(await relationshipBatch('Party', input.ids as string[])).values()].map(profile) };
  }
  const query = typeof input.query === 'string' ? input.query.trim().toLowerCase() : '';
  if (query.length > 200) throw new Error('Use up to 200 search characters.');
  const kind = input.kind === 'PERSON' || input.kind === 'ORGANIZATION' ? input.kind : undefined;
  const scope = hash(
    canonical([op, access.actor, access.admin, query, kind, input.archived === true, input.partyId ?? null]),
  );
  const cursor = relationshipCursor(input.nextToken, scope);
  if (op === 'relationshipSearch' || op === 'relationshipLegacyCandidates') {
    const legacy = op === 'relationshipLegacyCandidates';
    const names: Record<string, string> = {},
      values: Record<string, unknown> = {};
    const clauses: string[] = [];
    if (legacy) {
      Object.assign(names, {
        '#type': 'type',
        '#party': 'partyId',
        '#from': 'validFrom',
        '#until': 'validUntil',
      });
      Object.assign(values, {
        ':manager': 'MANAGER',
        ':nil': null,
        ':empty': '',
        ':day': agencyDay(new Date().toISOString()),
      });
      clauses.push(
        '#type = :manager',
        '(attribute_not_exists(#party) OR #party = :nil OR #party = :empty)',
        '(attribute_not_exists(#from) OR #from = :nil OR #from <= :day)',
        '(attribute_not_exists(#until) OR #until = :nil OR #until > :day)',
      );
    } else {
      if (input.archived !== true) {
        names['#archived'] = 'archived';
        values[':true'] = true;
        clauses.push('(attribute_not_exists(#archived) OR #archived <> :true)');
      }
      if (kind) {
        names['#kind'] = 'kind';
        values[':kind'] = kind;
        clauses.push('#kind = :kind');
      }
      if (query) {
        names['#search'] = 'directorySearch';
        values[':query'] = query;
        clauses.push('contains(#search, :query)');
      }
    }
    const items: RecordData[] = [];
    let key = cursor.key;
    const seen = new Set<string>();
    // At most 100 evaluated rows, 25 returned rows, and four requests per page.
    for (let n = 0; n < 4 && items.length < 25; n++) {
      const result = await db.send(
        new ScanCommand({
          TableName: table(legacy ? 'Contact' : 'Party'),
          Limit: 25 - items.length,
          ExclusiveStartKey: key,
          ...(clauses.length
            ? {
                FilterExpression: clauses.join(' AND '),
                ExpressionAttributeNames: names,
                ExpressionAttributeValues: values,
              }
            : {}),
        }),
      );
      items.push(...(result.Items ?? []));
      key = result.LastEvaluatedKey as typeof key;
      if (!key || !Object.keys(key).length) {
        key = undefined;
        break;
      }
      const signature = canonical(key);
      if (seen.has(signature)) throw new Error('Search did not advance. Please retry.');
      seen.add(signature);
    }
    if (!legacy) return { items: items.map(profile), nextToken: relationshipToken(scope, { key }) };
    const accounts = await visibleAccounts(
      items.map((r) => String(r.accountId)),
      identity,
      request,
    );
    return {
      items: items
        .filter((r) => accounts.has(String(r.accountId)))
        .map((contact) => ({
          id: contact.id,
          contact,
          accountName: accounts.get(String(contact.accountId))!.name,
        })),
      nextToken: relationshipToken(scope, { key }),
    };
  }
  if (typeof input.partyId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.partyId))
    throw new Error('Choose a relationship.');
  const client = await dataClient();
  if (op === 'relationshipPortfolio') {
    const page = await client.models.AccountRelationship.listAccountRelationshipByPartyId(
      { partyId: input.partyId },
      { limit: 25, nextToken: cursor.token },
    );
    if (page.errors?.length) throw new Error('Could not load the portfolio.');
    const links = [
      ...(
        await relationshipBatch(
          'AccountRelationship',
          page.data.map((r) => r.id),
        )
      ).values(),
    ];
    const accounts = await visibleAccounts(
      links.map((r) => String(r.accountId)),
      identity,
      request,
    );
    return {
      items: links
        .filter((r) => accounts.has(String(r.accountId)))
        .map((relationship) => ({
          id: relationship.id,
          relationship,
          account: accounts.get(String(relationship.accountId)),
        })),
      nextToken: relationshipToken(scope, { token: page.nextToken }),
    };
  }
  if (op === 'relationshipAffiliations') {
    const target = (await relationshipBatch('Party', [input.partyId])).get(input.partyId);
    if (!target) throw new Error('Profile is no longer available.');
    const page =
      target.kind === 'PERSON'
        ? await client.models.PartyAffiliation.listPartyAffiliationByPersonId(
            { personId: input.partyId },
            { limit: 25, nextToken: cursor.token },
          )
        : await client.models.PartyAffiliation.listPartyAffiliationByOrganizationId(
            { organizationId: input.partyId },
            { limit: 25, nextToken: cursor.token },
          );
    if (page.errors?.length) throw new Error('Could not load affiliations.');
    const profiles = await relationshipBatch(
      'Party',
      page.data.map((a) => (target.kind === 'PERSON' ? a.organizationId : a.personId)),
    );
    return {
      items: page.data.map((a) => ({
        ...a,
        relatedName:
          profiles.get(target.kind === 'PERSON' ? a.organizationId : a.personId)?.name ??
          'Unavailable profile',
      })),
      nextToken: relationshipToken(scope, { token: page.nextToken }),
    };
  }
  throw new Error('Unknown relationship read.');
}
