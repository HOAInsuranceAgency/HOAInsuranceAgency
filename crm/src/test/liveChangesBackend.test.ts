// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.unmock('../../amplify/functions/live-changes');
import { grantLivePublish } from '../../amplify/live-changes';
import { LIVE_NOTIFY_REQUEST, LIVE_NOTIFY_RESPONSE } from '../../amplify/account-access';

function resolver(name: string) {
  const extensions = { setSubscriptionFilter: vi.fn(), setSubscriptionInvalidationFilter: vi.fn() };
  const util = { unauthorized: () => { throw new Error('Unauthorized'); }, autoId: () => 'opaque-revision', transform: { toSubscriptionFilter: (value: unknown) => value } };
  const source = readFileSync(resolve('amplify/data', name), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, (ctx: any) => any> = {};
  runInNewContext(output, { exports, require: (name: string) => { if (name !== '@aws-appsync/utils') throw new Error('Unexpected import'); return { util, extensions }; } });
  return { request: exports.request, response: exports.response, extensions };
}
const context = (fieldName: string, identity: unknown, headers = {}, args = {}) => ({ info: { fieldName }, identity, request: { headers }, args });
const owner = { sub: 'owner-user', groups: ['OWNER', 'PRODUCER'], claims: {} };

describe('live AppSync authorization and payload boundaries', () => {
  it('queues native post-write notifications without waiting for publication or replacing the committed result', () => {
    expect(JSON.parse(LIVE_NOTIFY_REQUEST)).toEqual({ version: '2018-05-29', operation: 'Invoke', invocationType: 'Event', payload: { mode: 'notify', previous: true } });
    // Event invocations have a null result; the pipeline must return its
    // preceding native write rather than that asynchronous Lambda result.
    expect(LIVE_NOTIFY_RESPONSE).toBe('$util.toJson($ctx.prev.result)');
  });
  it('rejects browser identities and publishes only fresh opaque revisions', () => {
    const r = resolver('live-publish.js');
    for (const identity of [undefined, owner, { userArn: 'arn:aws:sts::123:assumed-role/browser', cognitoIdentityId: 'pool-user' }, { userArn: 'arn', cognitoIdentityPoolId: 'pool' }]) {
      expect(() => r.request(context('publishCrmChange', identity))).toThrow('Unauthorized');
    }
    const ctx = context('publishCrmChange', { userArn: 'arn:aws:sts::123:assumed-role/trusted/function' }, {}, { accountId: 'private-account', premium: 100, revision: 'forged' });
    expect(r.request(ctx)).toEqual({ payload: null });
    expect(r.response(ctx)).toEqual({ revision: 'opaque-revision' });
    expect(r.response({ ...ctx, info: { fieldName: 'publishPersonalChange' }, args: { userId: 'own-user', accountId: 'secret' } })).toEqual({ revision: 'opaque-revision', userId: 'own-user' });
  });

  it('honors active role and never accepts an arbitrary personal audience', () => {
    const r = resolver('live-subscribe.js');
    expect(() => r.response(context('onOwnerChange', owner, { 'X-CRM-Role': 'PRODUCER' }))).toThrow('Unauthorized');
    expect(() => r.response(context('onCrmChange', { sub: 'legacy', groups: [] }, { 'x-crm-role': 'STAFF' }))).toThrow('Unauthorized');
    expect(r.response(context('onCrmChange', { sub: 'legacy', groups: [] }))).toBeNull();
    expect(() => r.response(context('onOwnerChange', { sub: 'legacy', groups: [] }))).toThrow('Unauthorized');
    expect(() => r.response(context('onCrmChange', owner, { 'x-crm-role': 'ADMIN' }))).toThrow('Unauthorized');
    expect(r.response(context('onOwnerChange', owner, { 'x-crm-role': 'OWNER' }))).toBeNull();
    r.response(context('onPersonalChange', owner, { 'x-crm-role': 'PRODUCER' }, { userId: 'someone-else' }));
    expect(r.extensions.setSubscriptionFilter).toHaveBeenLastCalledWith({ userId: { eq: 'owner-user' } });
    expect(r.extensions.setSubscriptionInvalidationFilter).toHaveBeenLastCalledWith({ filterGroup: [{ filters: [{ fieldName: 'userId', operator: 'eq', value: 'owner-user' }] }] });
  });

  it('grants only the three service mutation fields without data infrastructure', () => {
    const stack = new Stack(new App(), 'LivePermissions');
    const role = new Role(stack, 'Writer', { assumedBy: new ServicePrincipal('lambda.amazonaws.com') });
    grantLivePublish(stack, [role], 'arn:aws:appsync:us-east-1:123456789012:apis/api-id');
    const resources = Template.fromStack(stack).toJSON().Resources;
    const policy = Object.values(resources).find((r: any) => r.Type === 'AWS::IAM::ManagedPolicy') as any;
    expect(policy.Properties.PolicyDocument.Statement).toEqual([{ Action: 'appsync:GraphQL', Effect: 'Allow', Resource: ['publishCrmChange', 'publishOwnerChange', 'publishPersonalChange'].map(field => `arn:aws:appsync:us-east-1:123456789012:apis/api-id/types/Mutation/fields/${field}`) }]);
    expect(Object.values(resources).every((r: any) => ['AWS::IAM::Role', 'AWS::IAM::ManagedPolicy'].includes(r.Type))).toBe(true);
  });
});

describe('best-effort publishing after committed work', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  it('signs opaque service messages and never throws on transport failure', async () => {
    vi.stubEnv('CRM_LIVE_ENDPOINT', 'https://api-id.appsync-api.us-east-1.amazonaws.com/graphql');
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'fictional-access'); vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'fictional-secret');
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { publishCrmChange: { revision: 'r' } } }) });
    vi.stubGlobal('fetch', fetcher);
    const { publishCrmChange, publishPersonalChange } = await import('../../amplify/functions/live-changes');
    await publishCrmChange();
    const request = fetcher.mock.calls[0][1];
    expect(request.headers.authorization).toMatch(/^AWS4-HMAC-SHA256/);
    expect(JSON.parse(request.body)).toEqual({ query: 'mutation NotifyCrm{publishCrmChange{revision}}' });
    fetcher.mockRejectedValueOnce(new Error('secret transport detail'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(publishPersonalChange('producer-user')).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith('Live notification unavailable; automatic refresh will recover.');
    expect(JSON.parse(fetcher.mock.calls[1][1].body).variables).toEqual({ userId: 'producer-user' });
  });
  it('reuses the exact pinned namespace endpoint without a new deployed environment setting', async () => {
    vi.stubEnv('CRM_LIVE_ENDPOINT', undefined); vi.stubEnv('HOA_MIGRATION_BRANCH', 'codex-hoa-staging-migration');
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'fictional-access'); vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'fictional-secret');
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetcher);
    const { publishOwnerChange } = await import('../../amplify/functions/live-changes');
    await publishOwnerChange();
    expect(String(fetcher.mock.calls[0][0])).toBe('https://6ibyan35zrfixjwpspnoi6dc2q.appsync-api.us-east-1.amazonaws.com/graphql');
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ query: 'mutation NotifyOwner{publishOwnerChange{revision}}' });
  });
  it('bounds a stalled notification instead of holding committed work open', async () => {
    vi.useFakeTimers();
    vi.stubEnv('CRM_LIVE_ENDPOINT', 'https://fictional.appsync-api.us-east-1.amazonaws.com/graphql');
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'fictional-access'); vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'fictional-secret');
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const { publishCrmChange } = await import('../../amplify/functions/live-changes');
    const work = publishCrmChange();
    await vi.advanceTimersByTimeAsync(1500);
    await expect(work).resolves.toBeUndefined();
  });
});
