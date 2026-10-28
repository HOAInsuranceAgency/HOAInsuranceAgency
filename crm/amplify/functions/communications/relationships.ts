import { randomUUID } from 'node:crypto';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { AccountAccess } from '../crm-access/access';
import type { Identity, RecordData } from '../crm-access/policy';
import type { RoleRequest } from '../crm-access/active-role';
import { activeTeamUserCheck, assertUserSession } from '../crm-access/user-status';
import { RELATIONSHIP_ROLES, directoryText, relationshipDates } from '../../../../shared/relationships';
import { validCalendarDate } from '../../../../shared/renewalPolicy';
import {
  get,
  row,
  put,
  check,
  absent,
  commit,
  audit,
  db,
  conflict,
  hash,
  canonical,
  type Write,
  type Row,
} from './store';
import { dataClient } from './data';

export const RELATIONSHIP_READS = new Set(['relationshipContext']);
export const RELATIONSHIP_WRITES = new Set([
  'relationshipSaveParty',
  'relationshipSaveAffiliation',
  'relationshipLink',
  'relationshipEnd',
  'relationshipChangeManagement',
]);
const table = (model: string) => {
  const name = process.env[`${model.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}_TABLE`];
  if (!name) throw new Error('Relationship storage is not configured.');
  return name;
};
async function read(model: string, id: string): Promise<RecordData | undefined> {
  return (await db.send(new GetCommand({ TableName: table(model), Key: { id }, ConsistentRead: true }))).Item;
}
function key(value: unknown) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value))
    throw new Error('Choose a valid record.');
  return value;
}
function revision(value: unknown) {
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error('Refresh before saving.');
  return Number(value);
}
function modelWrite(model: string, fields: RecordData, old?: RecordData): Write {
  const at = new Date().toISOString();
  return {
    Put: {
      TableName: table(model),
      Item: { ...old, ...fields, __typename: model, createdAt: old?.createdAt ?? at, updatedAt: at },
      ConditionExpression: old ? '#r = :r' : 'attribute_not_exists(id)',
      ...(old
        ? {
            ExpressionAttributeNames: { '#r': 'revision' },
            ExpressionAttributeValues: { ':r': old.revision },
          }
        : {}),
    },
  };
}
function modelCheck(model: string, record: RecordData): Write {
  return {
    ConditionCheck: {
      TableName: table(model),
      Key: { id: record.id },
      ConditionExpression: '#r = :r',
      ExpressionAttributeNames: { '#r': 'revision' },
      ExpressionAttributeValues: { ':r': record.revision },
    },
  };
}
function contactEnd(contact: RecordData, until: string, actor: string): Write {
  if (contact.validFrom && String(contact.validFrom) > until)
    throw new Error('The management change cannot precede the previous contact start date.');
  return {
    Update: {
      TableName: table('Contact'),
      Key: { id: contact.id },
      UpdateExpression: 'SET validUntil = :until, updatedAt = :now, lastWriteBy = :actor',
      ConditionExpression: 'accountId = :account AND updatedAt = :previous',
      ExpressionAttributeValues: {
        ':until': until,
        ':now': new Date().toISOString(),
        ':actor': actor,
        ':account': contact.accountId,
        ':previous': contact.updatedAt,
      },
    },
  };
}
async function party(id: unknown) {
  const record = await read('Party', key(id));
  if (!record || record.archived) throw new Error('Choose an active person or organization.');
  return record;
}
async function pageAll<T>(
  fetch: (token?: string) => Promise<{ data: T[]; errors?: readonly unknown[]; nextToken?: string | null }>,
) {
  const result: T[] = [];
  let token: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await fetch(token);
    if (page.errors?.length) throw new Error('Could not load relationships.');
    result.push(...page.data);
    token = page.nextToken ?? undefined;
    if (token && seen.has(token)) throw new Error('Relationship paging did not advance.');
    if (token) seen.add(token);
  } while (token);
  return result;
}
export async function relationshipOperation(
  op: string,
  input: RecordData,
  identity: Identity,
  request?: RoleRequest,
) {
  await assertUserSession(identity);
  const access = new AccountAccess(
    identity,
    (model, id) => (model === 'Communication' ? get(id) : read(model, id)),
    request,
  );
  const actor = access.actor;
  if (!RELATIONSHIP_READS.has(op) && !RELATIONSHIP_WRITES.has(op))
    throw new Error('Unknown relationship action.');
  const accountId = input.accountId ? key(input.accountId) : undefined;
  const accountWrites: Write[] = [];
  let accountWorkflow: Row<RecordData> | undefined;
  if (accountId) {
    await access.requireAccount(accountId);
    if (!(await read('Account', accountId)) || (await get(`deleted-account:${accountId}`)))
      throw new Error('This account is no longer available.');
    const workflow = await get(`workflow:${accountId}`);
    accountWorkflow = workflow;
    // Recheck the exact workflow used by the write, not a cached earlier assignment.
    if (!access.admin && workflow?.data.salespersonId !== actor)
      throw new Error('This account is no longer assigned to you.');
    accountWrites.push(
      workflow ? check(workflow) : absent(`workflow:${accountId}`),
      absent(`deleted-account:${accountId}`),
    );
  }
  if (op === 'relationshipContext') {
    if (!accountId) throw new Error('Choose an account.');
    const lock = await get<{ relationshipId?: string; effectiveOn?: string }>(`management:${accountId}`);
    const client = await dataClient();
    const links = await pageAll((token) =>
      client.models.AccountRelationship.listAccountRelationshipByAccountId(
        { accountId },
        { nextToken: token },
      ),
    );
    // Re-read GSI candidates and the authoritative latest relationship; never use a lagging end date.
    const ids = new Set([
      ...links.map((x) => x.id),
      ...(lock?.data.relationshipId ? [lock.data.relationshipId] : []),
    ]);
    const relationships = (await Promise.all([...ids].map((id) => read('AccountRelationship', id)))).filter(
      (x) => x?.accountId === accountId,
    );
    return {
      relationships,
      version: lock?.version ?? 0,
      selfManagedFrom: lock && !lock.data.relationshipId ? lock.data.effectiveOn : undefined,
    };
  }
  const requestId = key(input.requestId);
  const receiptId = `relationship-request:${actor}:${requestId}`,
    fingerprint = hash(canonical({ op, input }));
  const previous = await get<{ fingerprint: string; result: RecordData }>(receiptId);
  if (previous) {
    if (previous.data.fingerprint !== fingerprint)
      throw new Error('This request changed. Refresh and try again.');
    return previous.data.result;
  }
  let writes: Write[] = [],
    result: RecordData = {};
  if (op === 'relationshipSaveParty') {
    const id = input.id ? key(input.id) : randomUUID(),
      old = await read('Party', id);
    if (input.id && !old) throw new Error('This relationship no longer exists.');
    if (revision(input.revision) !== (old?.revision ?? 0))
      throw new Error('This profile changed. Refresh before saving.');
    if (old && !access.admin && old.ownerId !== actor)
      throw new Error('Only the relationship owner or an administrator can edit this profile.');
    const kind = input.kind;
    if (!['PERSON', 'ORGANIZATION'].includes(String(kind)) || (old && old.kind !== kind))
      throw new Error('Choose a person or organization. The record type cannot change.');
    const ownerId = input.ownerId
      ? key(input.ownerId)
      : input.ownerId === ''
        ? actor
        : String(old?.ownerId ?? actor);
    if (!access.admin && ownerId !== actor)
      throw new Error('Only an administrator can change the relationship owner.');
    if (ownerId !== actor) {
      const { enabledUser } = await import('./workflow');
      if (!(await enabledUser(ownerId))) throw new Error('Choose an active relationship owner.');
    }
    const email = directoryText(input.email, 320);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
    const website = directoryText(input.website, 1000);
    if (website && !/^https?:\/\//i.test(website))
      throw new Error('Website must begin with https:// or http://.');
    const fields = {
      id,
      kind,
      name: directoryText(input.name, 200, true),
      category: directoryText(input.category, 100),
      email,
      phone: directoryText(input.phone, 80),
      website,
      notes: directoryText(input.notes, 5000),
      ownerId,
      archived: input.archived === true,
      revision: Number(old?.revision ?? 0) + 1,
      updatedBy: actor,
    };
    writes = [modelWrite('Party', fields, old), ...(ownerId !== actor ? [activeTeamUserCheck(ownerId)] : [])];
    result = { party: fields };
  } else if (op === 'relationshipSaveAffiliation') {
    const person = await party(input.personId),
      organization = await party(input.organizationId);
    if (person.kind !== 'PERSON' || organization.kind !== 'ORGANIZATION')
      throw new Error('Choose a person and an organization.');
    if (!access.admin && person.ownerId !== actor && organization.ownerId !== actor)
      throw new Error('Only a relationship owner or administrator can edit affiliations.');
    const dates = relationshipDates(input.validFrom, input.validUntil);
    const id = input.id
        ? key(input.id)
        : hash(`affiliation:${person.id}:${organization.id}:${dates.validFrom ?? 'unknown'}`),
      old = await read('PartyAffiliation', id);
    if (
      (input.id && !old) ||
      (old && (old.personId !== person.id || old.organizationId !== organization.id)) ||
      revision(input.revision) !== (old?.revision ?? 0)
    )
      throw new Error('This affiliation changed. Refresh before saving.');
    const fields = {
      id,
      personId: person.id,
      organizationId: organization.id,
      title: directoryText(input.title, 200),
      ...dates,
      revision: Number(old?.revision ?? 0) + 1,
      updatedBy: actor,
    };
    writes = [
      modelWrite('PartyAffiliation', fields, old),
      modelCheck('Party', person),
      modelCheck('Party', organization),
    ];
    result = { affiliation: fields };
  } else {
    if (!accountId) throw new Error('Choose an account.');
    writes.push(...accountWrites);
    if (op === 'relationshipChangeManagement') {
      const workflow = accountWorkflow;
      if (workflow)
        writes[0] = put(
          row(
            'WORKFLOW',
            workflow.id,
            { ...workflow.data, humanTakeover: true, version: workflow.version + 1 },
            { accountId, previous: workflow },
          ),
          workflow,
        );
    }
    if (op === 'relationshipLink') {
      const target = await party(input.partyId),
        role = String(input.role);
      if (!RELATIONSHIP_ROLES.includes(role as never) || role === 'MANAGER')
        throw new Error('Use Change management to link a manager.');
      const dates = relationshipDates(input.validFrom, input.validUntil);
      const id = hash(`${accountId}:${target.id}:${role}:${dates.validFrom ?? 'unknown'}`);
      const fields = {
        id,
        accountId,
        partyId: target.id,
        role,
        ...dates,
        notes: directoryText(input.notes, 2000),
        revision: 1,
        updatedBy: actor,
      };
      writes.push(
        modelWrite('AccountRelationship', fields),
        modelCheck('Party', target),
        audit(accountId, actor, 'Relationship linked', { name: target.name, role, ...dates }),
      );
      result = { relationship: fields };
    } else if (op === 'relationshipEnd') {
      const old = await read('AccountRelationship', key(input.id));
      if (!old || old.accountId !== accountId || old.revision !== revision(input.revision))
        throw new Error('This relationship changed. Refresh before saving.');
      if (old.role === 'MANAGER') throw new Error('Use Change management to end a management relationship.');
      if (old.role === 'REFERRER') throw new Error('Original referral attribution remains in history.');
      const dates = relationshipDates(old.validFrom, input.validUntil);
      if (!dates.validUntil) throw new Error('Choose an end date.');
      if (old.validUntil) throw new Error('This relationship has already ended.');
      const fields = { ...old, ...dates, revision: Number(old.revision) + 1, updatedBy: actor };
      writes.push(
        modelWrite('AccountRelationship', fields, old),
        audit(accountId, actor, 'Relationship ended', { relationshipId: old.id, ...dates }),
      );
      result = { relationship: fields };
    } else if (op === 'relationshipChangeManagement') {
      const effective = input.effectiveOn;
      if (typeof effective !== 'string' || !validCalendarDate(effective))
        throw new Error('Choose the effective date.');
      const lockId = `management:${accountId}`,
        lock = await get<{ relationshipId?: string; effectiveOn?: string }>(lockId);
      if ((lock?.version ?? 0) !== revision(input.version))
        throw new Error('Management changed. Refresh before saving.');
      if (lock?.data.effectiveOn && lock.data.effectiveOn > effective)
        throw new Error('Choose a date on or after the latest management change.');
      const old = lock?.data.relationshipId
        ? await read('AccountRelationship', lock.data.relationshipId)
        : undefined;
      if (lock?.data.relationshipId && (!old || old.accountId !== accountId))
        throw new Error('Management history needs repair.');
      if (old?.validFrom && String(old.validFrom) > effective)
        throw new Error('Choose a date on or after the latest management start date.');
      const target = input.partyId ? await party(input.partyId) : undefined;
      const id = target ? randomUUID() : undefined;
      const contacts = new Map<string, RecordData>();
      const retireIds = input.retireContactIds ?? [];
      if (!Array.isArray(retireIds) || retireIds.length > 50)
        throw new Error('Choose up to 50 former contacts.');
      for (const contactId of new Set([
        ...(Array.isArray(old?.contactIds) ? old.contactIds : []),
        ...retireIds,
      ])) {
        const contact = await read('Contact', key(contactId));
        if (!contact || contact.accountId !== accountId)
          throw new Error('A selected contact is no longer on this account.');
        if (contact.validUntil && String(contact.validUntil) <= effective) continue;
        contacts.set(String(contact.id), contact);
      }
      const selections = new Map<string, { primary: boolean; billing: boolean; inspection: boolean }>();
      for (const [field, purpose] of [
        ['generalPartyId', 'primary'],
        ['billingPartyId', 'billing'],
        ['inspectionPartyId', 'inspection'],
      ] as const) {
        if (!input[field]) continue;
        const selectedId = key(input[field]),
          flags = selections.get(selectedId) ?? { primary: false, billing: false, inspection: false };
        flags[purpose] = true;
        selections.set(selectedId, flags);
      }
      if (!target && selections.size) throw new Error('Choose a manager before adding its contacts.');
      const contactIds: string[] = [],
        checkedParties = new Map<string, RecordData>();
      if (target) checkedParties.set(String(target.id), target);
      for (const [partyId, flags] of selections) {
        const selected = checkedParties.get(partyId) ?? (await party(partyId));
        checkedParties.set(partyId, selected);
        if ((flags.primary || flags.billing) && !selected.email && !selected.phone)
          throw new Error(`Add an email or phone number for ${selected.name} first.`);
        const contactId = randomUUID();
        contactIds.push(contactId);
        const at = new Date().toISOString();
        writes.push({
          Put: {
            TableName: table('Contact'),
            ConditionExpression: 'attribute_not_exists(id)',
            Item: {
              id: contactId,
              __typename: 'Contact',
              accountId,
              partyId,
              relationshipId: id,
              name: selected.name,
              email: selected.email ?? null,
              phone: selected.phone ?? null,
              type: flags.inspection
                ? 'INSPECTION'
                : flags.billing && !flags.primary
                  ? 'ACCOUNTING'
                  : 'MANAGER',
              isPrimary: flags.primary,
              isBilling: flags.billing,
              validFrom: effective,
              validUntil: null,
              lastWriteBy: actor,
              createdAt: at,
              updatedAt: at,
            },
          },
        });
      }
      for (const contact of contacts.values()) writes.push(contactEnd(contact, effective, actor));
      if (old)
        writes.push(
          modelWrite(
            'AccountRelationship',
            { ...old, validUntil: effective, revision: Number(old.revision) + 1, updatedBy: actor },
            old,
          ),
        );
      if (target)
        writes.push(
          modelWrite('AccountRelationship', {
            id,
            accountId,
            partyId: target.id,
            role: 'MANAGER',
            validFrom: effective,
            validUntil: null,
            contactIds,
            notes: directoryText(input.notes, 2000),
            revision: 1,
            updatedBy: actor,
          }),
        );
      for (const record of checkedParties.values()) writes.push(modelCheck('Party', record));
      writes.push(
        put(
          row(
            'MANAGEMENT',
            lockId,
            { relationshipId: id, effectiveOn: effective },
            { accountId, previous: lock },
          ),
          lock,
        ),
        audit(accountId, actor, target ? 'Management changed' : 'Account is self-managed', {
          manager: target?.name ?? 'Self-managed',
          effectiveOn: effective,
          retiredContactIds: [...contacts.keys()],
          contactIds,
          notes: directoryText(input.notes, 2000),
        }),
      );
      result = { version: (lock?.version ?? 0) + 1 };
    }
  }
  // All writes, contact handoffs, audit and retry receipt commit together.
  writes.push(
    activeTeamUserCheck(actor),
    put(row('RELATIONSHIP_REQUEST', receiptId, { fingerprint, result })),
  );
  try {
    await commit(writes);
  } catch (error) {
    if (!conflict(error)) throw error;
    const saved = await get<{ fingerprint: string; result: RecordData }>(receiptId);
    if (saved?.data.fingerprint === fingerprint) return saved.data.result;
    throw new Error('This record changed or is already linked. Refresh before saving.');
  }
  return result;
}
