import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, ScanCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { isActiveOwner, type RoleRequest } from '../crm-access/active-role';
import { reportBatchGet } from '../communications/dashboardStore';
import {
  calculateEmployeeProfitability, validateCompensationRecord, validateProfitabilityWindow, isProfitabilityDate,
  type EmployeeCompensation, type ProfitabilityEmployee, type ProfitabilityPolicy,
} from '../../../../shared/employeeProfitability';

type RecordData = Record<string, unknown>;
type Employee = ProfitabilityEmployee & { salesperson: boolean };
interface Sources {
  employees: Employee[];
  policies: ProfitabilityPolicy[];
  assignments: Record<string, { salespersonId?: string }>;
  compensations: Record<string, EmployeeCompensation>;
}
export interface ProfitabilityRepository {
  read: () => Promise<Sources>;
  save: (compensation: EmployeeCompensation, actor: string) => Promise<EmployeeCompensation>;
}
const db = DynamoDBDocumentClient.from(new DynamoDBClient(), { marshallOptions: { removeUndefinedValues: true } });
function configured(name: string) {
  const value = process.env[name];
  if (!value) throw new Error('Owner reporting storage is not configured.');
  return value;
}
function projection(fields: string[]) {
  const names: Record<string, string> = {};
  const expression = fields.map(field => field.split('.').map(part => {
    const key = Object.keys(names).find(name => names[name] === part) ?? `#f${Object.keys(names).length}`;
    names[key] = part; return key;
  }).join('.')).join(', ');
  return { ProjectionExpression: expression, ExpressionAttributeNames: names };
}
/** Follow every page, including empty filtered pages. Fail rather than render
 * partial financial totals when the bounded snapshot cannot be completed. */
async function collect(fetch: (cursor?: RecordData) => Promise<{ Items?: RecordData[]; LastEvaluatedKey?: RecordData }>) {
  const rows: RecordData[] = [], seen = new Set<string>();
  let cursor: RecordData | undefined;
  for (let page = 0; page < 200; page++) {
    const result = await fetch(cursor);
    rows.push(...result.Items ?? []);
    if (rows.length > 25000) throw new Error('This report is too large to load safely. Contact support.');
    cursor = result.LastEvaluatedKey;
    if (!cursor || !Object.keys(cursor).length) return rows;
    const key = JSON.stringify(cursor);
    if (seen.has(key)) throw new Error('The report could not finish loading. Please retry.');
    seen.add(key);
  }
  throw new Error('The report could not finish loading. Please retry.');
}
const profiles = () => collect(cursor => db.send(new ScanCommand({
  TableName: configured('USER_PROFILE_TABLE'), ConsistentRead: true, Limit: 250, ExclusiveStartKey: cursor,
  ...projection(['userId', 'firstName', 'lastName']),
})));
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const employeeName = (profile: RecordData) => `${text(profile.firstName)} ${text(profile.lastName)}`.trim() || 'Unnamed employee';

export const repository: ProfitabilityRepository = {
  async read() {
    const results = await Promise.allSettled([
      profiles(),
      collect(cursor => db.send(new ScanCommand({ TableName: configured('POLICY_TABLE'), ConsistentRead: true, Limit: 250, ExclusiveStartKey: cursor,
        ...projection(['id', 'accountId', 'effectiveDate', 'premium', 'commissionPct', 'status']),
      }))),
      // A strongly consistent partition query includes just-saved pay settings
      // without reading the growing private audit history or relying on a GSI.
      collect(cursor => db.send(new QueryCommand({ TableName: configured('OWNER_COMPENSATION_TABLE'), ConsistentRead: true, Limit: 250, ExclusiveStartKey: cursor,
        KeyConditionExpression: '#kind = :kind', ExpressionAttributeNames: { '#kind': 'kind' }, ExpressionAttributeValues: { ':kind': 'COMPENSATION' },
      }))),
      collect(cursor => db.send(new QueryCommand({ TableName: configured('COMMUNICATION_TABLE'), IndexName: 'kind', Limit: 250, ExclusiveStartKey: cursor,
        KeyConditionExpression: '#kind = :kind', ...projection(['data.userId', 'data.salesperson', 'data.name']),
        ExpressionAttributeNames: { ...projection(['data.userId', 'data.salesperson', 'data.name']).ExpressionAttributeNames, '#kind': 'kind' },
        ExpressionAttributeValues: { ':kind': 'ELIGIBILITY' },
      }))),
    ]);
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    const [people, policyRows, payRows, eligibility] = results.map(result => (result as PromiseFulfilledResult<RecordData[]>).value);
    const producers = new Set(eligibility.flatMap(row => {
      const data = row.data as RecordData | undefined;
      return data?.salesperson === true && text(data.userId) ? [text(data.userId)] : [];
    }));
    const employees = new Map<string, Employee>();
    for (const person of people) {
      const userId = text(person.userId);
      if (userId) employees.set(userId, { userId, name: employeeName(person), salesperson: producers.has(userId) });
    }
    // Profiles are optional until onboarding completes. Eligibility is saved
    // only for verified teammates and already carries their roster name.
    for (const row of eligibility) {
      const data = row.data as RecordData | undefined, userId = text(data?.userId);
      if (userId && !employees.has(userId)) employees.set(userId, {
        userId, name: text(data?.name) || `Unavailable teammate (${userId.slice(-8)})`, salesperson: producers.has(userId),
      });
    }
    const compensations: Sources['compensations'] = {};
    for (const row of payRows) {
      const compensation = validateCompensationRecord(row);
      if (row.id !== `compensation:${compensation.userId}` || compensations[compensation.userId]) throw new Error('Compensation history needs review.');
      compensations[compensation.userId] = compensation;
      if (!employees.has(compensation.userId)) employees.set(compensation.userId, {
        userId: compensation.userId, name: text(row.employeeName) || 'Former employee', salesperson: producers.has(compensation.userId),
      });
    }
    const ids = [...new Set(policyRows.map(policy => text(policy.accountId)).filter(Boolean))];
    const assignments: Sources['assignments'] = {};
    for (let start = 0; start < ids.length; start += 500) {
      const batch = ids.slice(start, start + 500);
      const workflows = await reportBatchGet(configured('COMMUNICATION_TABLE'), batch.map(id => `workflow:${id}`), ['data.salespersonId']);
      for (const accountId of batch) {
        const data = workflows.get(`workflow:${accountId}`)?.data as RecordData | undefined;
        assignments[accountId] = { salespersonId: text(data?.salespersonId) || undefined };
      }
    }
    return { employees: [...employees.values()].sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId)),
      policies: policyRows as unknown as ProfitabilityPolicy[], assignments, compensations };
  },
  async save(input, actor) {
    const table = configured('OWNER_COMPENSATION_TABLE'), id = `compensation:${input.userId}`;
    const old = (await db.send(new GetCommand({ TableName: table, Key: { kind: 'COMPENSATION', id }, ConsistentRead: true }))).Item;
    if ((old?.version ?? 0) !== input.version) throw new Error('Compensation changed. Refresh before saving.');
    const employee = (await profiles()).find(profile => profile.userId === input.userId);
    let eligibility: RecordData | undefined;
    if (!employee && !old) {
      const id = `eligibility:${input.userId}`;
      const found = await reportBatchGet(configured('COMMUNICATION_TABLE'), [id], ['kind', 'data.userId', 'data.name']);
      const entry = found.get(id), data = entry?.data as RecordData | undefined;
      if (entry?.kind !== 'ELIGIBILITY' || data?.userId !== input.userId) throw new Error('Choose an existing employee.');
      eligibility = data;
    }
    const compensation = { ...input, version: input.version + 1 }, at = new Date().toISOString();
    await db.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: table, Item: { id, kind: 'COMPENSATION', ...compensation,
        employeeName: employee ? employeeName(employee) : text(old?.employeeName) || text(eligibility?.name) || `Unavailable teammate (${input.userId.slice(-8)})`, updatedAt: at, updatedBy: actor },
        ConditionExpression: old ? '#version = :version' : 'attribute_not_exists(id)',
        ...(old ? { ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':version': input.version } } : {}),
      } },
      { Put: { TableName: table, ConditionExpression: 'attribute_not_exists(id)', Item: {
        id: `audit:${randomUUID()}`, kind: 'COMPENSATION_AUDIT', userId: input.userId, actor, at,
        previous: old ? validateCompensationRecord(old, input.userId) : null, current: compensation,
      } } },
    ] }));
    return compensation;
  },
};

type Event = { fieldName?: string; info?: { fieldName?: string }; identity?: unknown; request?: RoleRequest; arguments?: RecordData };
export function createHandler(store: ProfitabilityRepository) {
  return async (event: Event) => {
    try {
      const actor = text((event.identity as { sub?: string } | undefined)?.sub);
      if (!actor || !isActiveOwner(event.identity, event.request)) throw new Error('Only Owners can access employee profitability and compensation.');
      const args = event.arguments ?? {}, field = event.fieldName ?? event.info?.fieldName;
      if (field === 'ownerProfitability') {
        const window = validateProfitabilityWindow(args.from, args.to);
        const source = await store.read();
        const owners = new Set(source.policies.filter(policy => policy.status !== 'CANCELLED' &&
          (!isProfitabilityDate(policy.effectiveDate) || policy.effectiveDate >= window.from && policy.effectiveDate <= window.to))
          .map(policy => source.assignments[policy.accountId]?.salespersonId));
        const report = calculateEmployeeProfitability({ ...window, ...source,
          employees: source.employees.filter(employee => employee.salesperson || source.compensations[employee.userId] || owners.has(employee.userId)),
        });
        return { ok: true, employees: source.employees, compensations: source.compensations, report };
      }
      if (field === 'saveEmployeeCompensation') {
        const terms = typeof args.terms === 'string' ? JSON.parse(args.terms) : args.terms;
        const compensation = validateCompensationRecord({ userId: args.userId, version: args.version, terms });
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(compensation.userId)) throw new Error('Choose an existing employee.');
        return { ok: true, compensation: await store.save(compensation, actor) };
      }
      throw new Error('Unknown owner reporting request.');
    } catch (error) {
      const kind = (error as { name?: string })?.name;
      const message = kind === 'TransactionCanceledException' || kind === 'ConditionalCheckFailedException'
        ? 'Compensation changed. Refresh before saving.'
        : error instanceof Error ? error.message : 'Could not load owner reporting. Please retry.';
      return { ok: false, error: message };
    }
  };
}
export const handler = createHandler(repository);
