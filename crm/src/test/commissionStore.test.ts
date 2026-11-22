import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@aws-sdk/lib-dynamodb', async (original) => ({
  ...(await original<typeof import('@aws-sdk/lib-dynamodb')>()),
  DynamoDBDocumentClient: { from: () => ({ send: h.send }) },
}));
import { commit, list, getMany, auditPage, approvedPayrollCycles } from '../../amplify/functions/commissions/store';
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('COMMISSION_TABLE', 'private');
});
it('conditionally posts immutable source locks, versioned changes, and private audit together', async () => {
  h.send.mockResolvedValue({});
  await commit(
    [
      {
        kind: 'STATEMENT',
        value: { id: 's', version: 2, status: 'POSTED' },
        previous: { id: 's', version: 2 },
      },
      { kind: 'CARRIER_TRANSACTION', value: { id: 'txn' } },
    ],
    'owner',
  );
  const command = h.send.mock.calls[0][0];
  expect(command.constructor.name).toBe('TransactWriteCommand');
  const items = command.input.TransactItems;
  expect(items).toHaveLength(3);
  expect(items.every((i: { Put: { TableName: string } }) => i.Put.TableName === 'private')).toBe(
    true,
  );
  expect(items[0].Put).toMatchObject({
    ConditionExpression: '#v = :v',
    ExpressionAttributeValues: { ':v': 2 },
    Item: { version: 3, updatedBy: 'owner' },
  });
  expect(items[1].Put.ConditionExpression).toBe('attribute_not_exists(id)');
  expect(items[2].Put.Item).toMatchObject({ kind: 'AUDIT', actor: 'owner' });
});
it('follows empty pages and refuses repeated cursors rather than returning incomplete totals', async () => {
  h.send
    .mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { id: 'next' } })
    .mockResolvedValueOnce({ Items: [{ id: 's' }] });
  expect(await list('STATEMENT')).toEqual([{ id: 's' }]);
  expect(h.send.mock.calls[1][0].input.ExclusiveStartKey).toEqual({ id: 'next' });
  h.send.mockResolvedValue({ Items: [], LastEvaluatedKey: { id: 'loop' } });
  await expect(list('POLICY')).rejects.toThrow(/completely loaded/);
});
it('uses only the authenticated producer partition for self-service discovery', async () => {
  h.send.mockResolvedValue({ Items: [] });
  await list('producer-id', true);
  expect(h.send.mock.calls[0][0].input).toMatchObject({
    IndexName: 'producer',
    ExpressionAttributeNames: { '#key': 'producerId' },
    ExpressionAttributeValues: { ':value': 'producer-id' },
  });
});

it('loads authoritative records in batches of 100 and retries only unprocessed keys', async () => {
  const refs = Array.from({ length: 101 }, (_, i) => ({ kind: 'POLICY', id: String(i) }));
  h.send
    .mockResolvedValueOnce({
      Responses: { private: refs.slice(0, 99) },
      UnprocessedKeys: { private: { Keys: [refs[99]] } },
    })
    .mockResolvedValueOnce({ Responses: { private: [refs[99]] } })
    .mockResolvedValueOnce({ Responses: { private: [refs[100]] } });
  expect(await getMany(refs)).toEqual(refs);
  expect(
    h.send.mock.calls.map(([command]) => command.input.RequestItems.private.Keys.length),
  ).toEqual([100, 1, 1]);
  for (const [command] of h.send.mock.calls) {
    expect(command.constructor.name).toBe('BatchGetCommand');
    expect(command.input.RequestItems.private.ConsistentRead).toBe(true);
  }
});
it('fails a throttled batch without returning partial commission totals', async () => {
  const refs = [{ kind: 'POLICY', id: 'p' }];
  h.send.mockResolvedValue({ UnprocessedKeys: { private: { Keys: refs } } });
  await expect(getMany(refs)).rejects.toThrow(/completely loaded/);
  expect(h.send).toHaveBeenCalledTimes(5);
});
it('filters payroll discovery by producer and record kind in DynamoDB', async () => {
  h.send.mockResolvedValue({ Items: [] });
  await list('producer', true, 'POLICY');
  expect(h.send.mock.calls[0][0].input).toMatchObject({
    IndexName: 'producer',
    FilterExpression: '#kind = :kind',
    ExpressionAttributeValues: { ':value': 'producer', ':kind': 'POLICY' },
  });
});
it('pages audit records with consistent reads and rejects a cursor from another partition', async () => {
  h.send.mockResolvedValueOnce({Items:[{id:'audit#2026-11-05#one',actor:'owner'}],LastEvaluatedKey:{kind:'AUDIT',id:'audit#2026-11-05#one'}}).mockResolvedValueOnce({Items:[]});
  const page=await auditPage();expect(page.entries).toHaveLength(1);
  await auditPage(page.cursor);expect(h.send.mock.calls[1][0].input).toMatchObject({ConsistentRead:true,Limit:25,ScanIndexForward:false,ExclusiveStartKey:{kind:'AUDIT',id:'audit#2026-11-05#one'}});
  await expect(auditPage(Buffer.from(JSON.stringify({phase:'current',key:{kind:'POLICY',id:'p'}})).toString('base64url'))).rejects.toThrow(/Invalid audit page/);
  expect(h.send).toHaveBeenCalledTimes(2);
});
it('archives PDF content once and records its hash and version in the same private audit transaction', async () => {
  h.send.mockResolvedValue({});
  await commit([{kind:'PAYROLL_REPORT_FILE',value:{id:'report:summary',reportId:'report',sha256:'digest',content:'compressed-pdf'}}],'owner');
  const writes=h.send.mock.calls[0][0].input.TransactItems;
  expect(writes[0].Put.Item.content).toBe('compressed-pdf');
  expect(writes[1].Put.Item.changes[0]).toMatchObject({previousVersion:0,newVersion:1,value:{sha256:'digest'}});
  expect(writes[1].Put.Item.changes[0].value.content).toBeUndefined();
  expect(writes[1].Put.Item.id).toMatch(/^audit#\d{4}-\d\d-\d\dT.*#/);
});
it('continues into earlier-format audit records without deleting or hiding their history', async () => {
  h.send.mockResolvedValueOnce({Items:[]}).mockResolvedValueOnce({Items:[{id:'legacy-uuid',at:'2026-10-01T12:00:00Z'}]});
  const current=await auditPage();const legacy=await auditPage(current.cursor);
  expect(legacy.legacy).toBe(true);expect(legacy.entries).toHaveLength(1);expect(legacy.cursor).toBeUndefined();
  expect(h.send.mock.calls[1][0].input).toMatchObject({KeyConditionExpression:'#kind = :kind',ExpressionAttributeValues:{':kind':'AUDIT'}});
});

it('filters current-format audit rows after a bounded legacy query and preserves empty-page cursors', async () => {
  const key = {kind:'AUDIT',id:'audit#2026-11-05#one'};
  h.send.mockResolvedValueOnce({Items:[key],LastEvaluatedKey:key}).mockResolvedValueOnce({Items:[{id:'earlier-uuid'}]});
  const page = await auditPage(Buffer.from(JSON.stringify({phase:'legacy'})).toString('base64url'));
  expect(page.entries).toEqual([]);
  expect(page.cursor).toBeTruthy();
  expect(h.send.mock.calls[0][0].input).not.toHaveProperty('FilterExpression');
  expect(h.send.mock.calls[0][0].input.ExpressionAttributeValues).toEqual({':kind':'AUDIT'});
  expect((await auditPage(page.cursor)).entries).toEqual([{id:'earlier-uuid'}]);
  expect(h.send.mock.calls[1][0].input.ExclusiveStartKey).toEqual(key);
});

it.each([
  ['OPEN', 'APPROVED', 'Put'],
  ['APPROVED', 'OPEN', 'Delete'],
  ['APPROVED', 'PAID', 'Delete'],
  ['APPROVED', 'CANCELLED', 'Delete'],
  ['APPROVED', 'APPROVED', undefined],
  ['OPEN', 'CANCELLED', undefined],
])('updates the active reference only when payroll moves from %s to %s', async (previousStatus, status, operation) => {
  h.send.mockResolvedValue({});
  const id = '2026-11';
  await commit([{kind: 'PAYROLL_CYCLE', previous: {id, version: 2, status: previousStatus},
    value: {id, status, reviewRequired: 'Review changed receipts.'}}], 'owner');
  expect(h.send).toHaveBeenCalledTimes(1);
  const writes = h.send.mock.calls[0][0].input.TransactItems;
  expect(writes[0].Put).toMatchObject({ConditionExpression: '#v = :v', ExpressionAttributeValues: {':v': 2},
    Item: {kind: 'PAYROLL_CYCLE', id, status, version: 3}});
  expect(writes[1].Put.Item.kind).toBe('AUDIT');
  if (operation) {
    expect(writes.slice(2)).toEqual([{[operation]: {TableName: 'private',
      [operation === 'Put' ? 'Item' : 'Key']: {kind: 'PAYROLL_APPROVED', id}}}]);
  } else {
    expect(writes).toHaveLength(2);
  }
});

it('queries only active payroll references after backfill and checks each current status and exact cutoff', async () => {
  const approved = {id: '2026-11', status: 'APPROVED', cutoff: '2026-10-29'};
  const nowPaid = {id: '2026-11-OFF-12345678', status: 'PAID', cutoff: '2026-10-31'};
  const tooEarly = {id: '2026-10-OFF-12345678', status: 'APPROVED', cutoff: '2026-10-28'};
  const sources = [approved, nowPaid, tooEarly];
  h.send.mockResolvedValueOnce({Item: {id: 'approved-payroll-cycles-v1'}})
    .mockResolvedValueOnce({Items: sources.map(({id}) => ({id}))})
    .mockResolvedValueOnce({Responses: {private: sources}});
  expect(await approvedPayrollCycles('2026-10-29')).toEqual([approved]);
  expect(h.send.mock.calls[0][0].input).toMatchObject({ConsistentRead: true, Key: {kind: 'INDEX_STATE', id: 'approved-payroll-cycles-v1'}});
  expect(h.send.mock.calls[1][0].input).toMatchObject({ConsistentRead: true, ProjectionExpression: '#id',
    KeyConditionExpression: '#kind = :kind AND #id >= :month',
    ExpressionAttributeValues: {':kind': 'PAYROLL_APPROVED', ':month': '2026-10'}});
  expect(h.send.mock.calls[2][0].input.RequestItems.private).toEqual({ConsistentRead: true,
    Keys: sources.map(({id}) => ({kind: 'PAYROLL_CYCLE', id}))});
});

it('finds a pre-index approval after 5,100 closed payroll cycles before backfill is ready', async () => {
  const approved = {id: '2026-11', status: 'APPROVED', cutoff: '2026-10-31'};
  h.send.mockResolvedValueOnce({});
  for (let i = 0; i < 51; i++) {
    h.send.mockResolvedValueOnce({Items: [], ScannedCount: 100,
      LastEvaluatedKey: {kind: 'PAYROLL_CYCLE', id: '2026-10-OFF-' + i.toString(16).padStart(8,'0')}});
  }
  h.send.mockResolvedValueOnce({Items: [approved]});
  expect(await approvedPayrollCycles('2026-10-31')).toEqual([approved]);
  expect(h.send).toHaveBeenCalledTimes(53);
  for (const [command] of h.send.mock.calls.slice(1)) {
    expect(command.input).toMatchObject({ConsistentRead: true, Limit: 100,
      KeyConditionExpression: '#kind = :kind AND #id >= :month',
      FilterExpression: '#status = :approved AND #cutoff >= :date',
      ExpressionAttributeValues: {':kind': 'PAYROLL_CYCLE', ':approved': 'APPROVED', ':month': '2026-10', ':date': '2026-10-31'}});
  }
});

it('bounds compatibility reads and identifies the backfill when payroll history exhausts the page budget', async () => {
  let page = 0;
  h.send.mockResolvedValueOnce({});
  h.send.mockImplementation(async () => ({Items: [], LastEvaluatedKey: {kind: 'PAYROLL_CYCLE', id: String(++page)}}));
  await expect(approvedPayrollCycles()).rejects.toThrow(/complete the approved payroll lookup backfill/i);
  expect(page).toBe(100);
  expect(h.send.mock.calls[1][0].input).toMatchObject({KeyConditionExpression: '#kind = :kind',
    FilterExpression: '#status = :approved', ExpressionAttributeNames: {'#kind': 'kind', '#status': 'status'}});
});

it('fails closed for an active payroll reference without its authoritative cycle', async () => {
  h.send.mockResolvedValueOnce({Item: {id: 'approved-payroll-cycles-v1'}})
    .mockResolvedValueOnce({Items: [{id: '2026-11'}]})
    .mockResolvedValueOnce({Responses: {private: []}});
  await expect(approvedPayrollCycles()).rejects.toThrow(/payroll cycle is missing/);
});
