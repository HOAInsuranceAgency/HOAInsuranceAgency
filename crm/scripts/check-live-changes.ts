import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CfnResource, Stack } from 'aws-cdk-lib';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import { CfnFunctionConfiguration, CfnResolver } from 'aws-cdk-lib/aws-appsync';
import type { CfnFunction } from 'aws-cdk-lib/aws-lambda';
import { LIVE_PUBLISH_FIELDS, livePublisherFunctions } from '../amplify/live-changes';
import { migrationTargets } from '../amplify/migration-config';
import type { backend as Backend } from '../amplify/backend';

/** Check generated infrastructure, including IAM-enabled schema fields, rather
 * than treating a passing resolver unit test as evidence of deployable push. */
export function checkLiveChanges(backend: typeof Backend) {
  const nodes = backend.stack.node.root.node.findAll();
  const resources = backend.data.resources.cfnResources;
  const resolvers = nodes.filter((node): node is CfnResolver => node instanceof CfnResolver);
  const subscriptions = ['onCrmChange', 'onOwnerChange', 'onPersonalChange'];
  for (const field of [...LIVE_PUBLISH_FIELDS, ...subscriptions]) {
    const matches = resolvers.filter(resolver => resolver.fieldName === field);
    if (matches.length !== 1) throw new Error(`Missing live-change operation: ${field}`);
    const rendered = Object.values(Stack.of(matches[0]).resolve(matches[0]._toCloudFormation()).Resources as Record<string, { DependsOn?: string[] }>)[0];
    if (!rendered.DependsOn?.includes(Stack.of(resources.cfnGraphqlSchema).getLogicalId(resources.cfnGraphqlSchema)) || rendered.DependsOn.length > 3) throw new Error(`Live resolver must depend only on the exact schema: ${field}`);
    const subscription = subscriptions.includes(field);
    const fn = nodes.find((node): node is CfnFunctionConfiguration => node instanceof CfnFunctionConfiguration && node.name === `Fn_${subscription ? 'Subscription' : 'Mutation'}_${field}_1`);
    const stages = (matches[0].pipelineConfig as CfnResolver.PipelineConfigProperty).functions ?? [];
    if (!fn || !stages.includes(fn.attrFunctionId)) throw new Error(`Missing live authorization handler: ${field}`);
    const location = JSON.stringify(Stack.of(fn).resolve(fn.codeS3Location));
    const asset = nodes.find((node): node is Asset => node instanceof Asset && JSON.stringify(Stack.of(fn).resolve(node.s3ObjectUrl)) === location);
    const stage = asset?.node.tryFindChild('Stage') as { absoluteStagedPath: string } | undefined;
    if (!stage || readFileSync(stage.absoluteStagedPath, 'utf8') !== readFileSync(resolve('amplify/data', subscription ? 'live-subscribe.js' : 'live-publish.js'), 'utf8')) throw new Error(`Live resolver must deploy the tested authorization handler: ${field}`);
    const fnRendered = Object.values(Stack.of(fn).resolve(fn._toCloudFormation()).Resources as Record<string, { DependsOn?: string[] }>)[0];
    if ((fnRendered.DependsOn?.length ?? 0) > 3) throw new Error(`Live JS handler has an unnecessarily broad API dependency: ${field}`);
  }
  const notify = nodes.find((node): node is CfnFunctionConfiguration => node instanceof CfnFunctionConfiguration && node.name === 'access_notify___');
  if (!notify || notify.responseMappingTemplate !== '$util.toJson($ctx.prev.result)' || JSON.parse(notify.requestMappingTemplate ?? '{}').invocationType !== 'Event') throw new Error('Live invalidation must run asynchronously and preserve committed results');
  for (const resolver of resolvers) {
    const native = Object.values(backend.data.resources.tables).some(table => resolver.requestMappingTemplate?.includes(`"tableName", "${table.tableName}"`));
    if (native && resolver.typeName === 'Mutation' && (resolver.pipelineConfig as CfnResolver.PipelineConfigProperty).functions?.at(-1) !== notify.attrFunctionId) throw new Error(`Native write has no trailing invalidation: ${resolver.fieldName}`);
  }
  const schemas = nodes.filter((node): node is Asset => node instanceof Asset).flatMap(asset => {
    const stage = asset.node.tryFindChild('Stage') as { absoluteStagedPath?: string } | undefined;
    const path = stage?.absoluteStagedPath;
    return path?.endsWith('.graphql') ? [readFileSync(path, 'utf8')] : [];
  });
  const schema = schemas.find(source => source.includes('publishCrmChange:'));
  if (!schema || LIVE_PUBLISH_FIELDS.some(field => !new RegExp(`${field}[^\\n]+@aws_iam`).test(schema))) throw new Error('Service publishers must be enabled for explicit IAM field permissions');
  const target = migrationTargets.branches[process.env.AWS_BRANCH as keyof typeof migrationTargets.branches];
  if (!target) return;
  for (const fn of livePublisherFunctions(backend)) {
    const resource = fn.resources.lambda.node.defaultChild as CfnFunction;
    const env = Stack.of(resource).resolve(resource.environment) as { variables: Record<string, unknown> };
    const branch = env.variables.HOA_MIGRATION_BRANCH;
    const runtime = migrationTargets.branches[branch as keyof typeof migrationTargets.branches];
    if (typeof branch !== 'string' || runtime?.graphqlUrl !== target.graphqlUrl || env.variables.CRM_LIVE_ENDPOINT !== undefined) throw new Error(`Live endpoint must use the existing retained namespace fence: ${resource.node.path}`);
  }
  const policies = nodes.filter((node): node is CfnResource => node instanceof CfnResource && node.cfnResourceType === 'AWS::IAM::ManagedPolicy' && node.node.path.includes('/LiveChangePermissions/'));
  if (policies.length !== 1) throw new Error('Live publishers need one bounded service-only permission attachment');
  const rendered = Object.values(Stack.of(policies[0]).resolve(policies[0]._toCloudFormation()).Resources as Record<string, { Properties: { PolicyDocument: { Statement: { Action: string | string[]; Resource: unknown[] }[] } } }>)[0];
  const statement = rendered.Properties.PolicyDocument.Statement;
  if (statement.length !== 1 || JSON.stringify(statement[0].Action) !== JSON.stringify('appsync:GraphQL') || statement[0].Resource.length !== 3 || JSON.stringify(statement[0].Resource).includes('*')) throw new Error('Live permissions must grant exactly three mutation fields');
}
