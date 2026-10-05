import { readFileSync } from 'node:fs';
import { CfnResource, Stack } from 'aws-cdk-lib';
import { CfnFunctionConfiguration } from 'aws-cdk-lib/aws-appsync';
import { CfnFunction } from 'aws-cdk-lib/aws-lambda';
import { CfnTable } from 'aws-cdk-lib/aws-dynamodb';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import { AssetStaging } from 'aws-cdk-lib';
import type { backend as Backend } from '../amplify/backend';
import { OWNER_OPERATIONS } from '../amplify/functions/crm-access/policy';

type Statement = { Effect?: string; Action?: string | string[]; Resource?: unknown | unknown[] };
type PolicyDocument = { Statement?: Statement[] };
type Properties = Record<string, unknown> & { PolicyDocument?: PolicyDocument; Policies?: { PolicyDocument?: PolicyDocument }[]; Roles?: unknown[]; RoleName?: unknown };
type Resource = { Type: string; Properties?: Properties; DeletionPolicy?: string; UpdateReplacePolicy?: string };
const json = (value: unknown) => JSON.stringify(value);

/** Validate the deployed boundary, not merely the UI's Owner-only controls. */
export function checkOwnerProfitability(backend: typeof Backend) {
  const nodes = backend.stack.node.root.node.findAll();
  if (!backend.auth.resources.groups.OWNER) throw new Error('The Owner Cognito group is required');
  if ('EmployeeCompensation' in backend.data.resources.tables) throw new Error('Compensation must not be registered as an AppSync model');
  const tables = nodes.filter((node): node is CfnTable => node instanceof CfnTable && node.node.path.includes('/EmployeeCompensation/'));
  if (tables.length !== 1) throw new Error('Owner compensation must have one private table');
  const table = tables[0], tableStack = Stack.of(table);
  const rendered = Object.values(tableStack.resolve(table._toCloudFormation()).Resources as Record<string, Resource>)[0];
  const props = rendered.Properties;
  const encryption = props?.SSESpecification as { SSEEnabled?: boolean; SSEType?: string } | undefined;
  // DynamoDB's default SSE type is KMS; CDK omits SSEType for AWS_MANAGED.
  if (encryption?.SSEEnabled !== true || (encryption.SSEType !== undefined && encryption.SSEType !== 'KMS') ||
      (props?.PointInTimeRecoverySpecification as Record<string, unknown>)?.PointInTimeRecoveryEnabled !== true ||
      rendered.DeletionPolicy !== 'Retain' || rendered.UpdateReplacePolicy !== 'Retain') {
    throw new Error('Private compensation needs KMS encryption, point-in-time recovery and retention');
  }
  if (json(props?.KeySchema) !== json([{ AttributeName: 'kind', KeyType: 'HASH' }, { AttributeName: 'id', KeyType: 'RANGE' }])) throw new Error('Compensation must be partitioned separately from its audit history');
  // Generated cross-stack parameters retain the unique construct name, while
  // CDK can assign a different logical-ID suffix to the exported output. Do not resolve a new reference in other stacks:
  // doing that in a checker would create the very dependency being inspected.
  const referencesSalary = (value: unknown) => json(value)?.includes('EmployeeCompensation') === true;
  const fn = backend.ownerProfitability.resources.lambda;
  const ownerFunction = fn.node.defaultChild as CfnFunction;
  const ownerRole = fn.role!.node.defaultChild as CfnResource;
  const ownerRoleStack = Stack.of(ownerRole), ownerRoleId = ownerRoleStack.getLogicalId(ownerRole);
  const referencesOwnerRole = (node: CfnResource, value: unknown) => Stack.of(node) === ownerRoleStack && json(value) === json({ Ref: ownerRoleId });
  const salaryActions = new Set<string>();
  for (const node of nodes) {
    if (!(node instanceof CfnResource)) continue;
    const resource = Object.values(Stack.of(node).resolve(node._toCloudFormation()).Resources as Record<string, Resource>)[0];
    const properties = resource.Properties;
    if (resource.Type === 'AWS::AppSync::DataSource' && referencesSalary(properties?.DynamoDBConfig)) throw new Error('Compensation must never be an AppSync model or data source');
    if (resource.Type === 'AWS::Lambda::Function') {
      const vars = (properties?.Environment as { Variables?: Record<string, unknown> })?.Variables;
      if ((vars?.OWNER_COMPENSATION_TABLE !== undefined || referencesSalary(vars)) && node !== ownerFunction) throw new Error(`Another Lambda has compensation configuration: ${node.node.path}`);
      if (node === ownerFunction && !referencesSalary(vars?.OWNER_COMPENSATION_TABLE)) throw new Error('Owner Lambda must use the private compensation table');
    }
    const documents = resource.Type === 'AWS::IAM::Role'
      ? (properties?.Policies ?? []).flatMap(policy => policy.PolicyDocument ? [policy.PolicyDocument] : [])
      : properties?.PolicyDocument ? [properties.PolicyDocument] : [];
    const ownerOnly = node === ownerRole ||
      resource.Type === 'AWS::IAM::RolePolicy' && referencesOwnerRole(node, properties?.RoleName) ||
      ['AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy'].includes(resource.Type) && properties?.Roles?.length === 1 && referencesOwnerRole(node, properties.Roles[0]);
    for (const statement of documents.flatMap(document => document.Statement ?? [])) {
      if (statement.Effect !== 'Allow' || ![statement.Action].flat().some(action =>
        typeof action === 'string' && /^(\*|dynamodb:(\*|GetItem|BatchGetItem|Query|Scan|PutItem|UpdateItem|DeleteItem|BatchWriteItem|TransactGetItems|TransactWriteItems|PartiQL.*))$/.test(action))) continue;
      for (const resourceArn of [statement.Resource].flat()) {
        const broad = resourceArn === '*' || /table\/\*/.test(json(resourceArn) ?? '');
        if (!referencesSalary(resourceArn) && !broad) continue;
        if (!ownerOnly || broad) throw new Error(`Compensation data access must be exact and exclusive to the Owner Lambda: ${node.node.path}`);
        for (const action of [statement.Action].flat()) if (typeof action === 'string') salaryActions.add(action);
      }
    }
  }
  for (const action of ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:PutItem']) {
    if (!salaryActions.has(action)) throw new Error(`Owner Lambda lacks its exact private compensation grant: ${action}`);
  }

  const functions = nodes.filter((node): node is CfnFunctionConfiguration => node instanceof CfnFunctionConfiguration);
  const templateFor = (fn: CfnFunctionConfiguration) => {
    if (fn.requestMappingTemplate) return fn.requestMappingTemplate;
    if (!fn.requestMappingTemplateS3Location) return '';
    const location = json(Stack.of(fn).resolve(fn.requestMappingTemplateS3Location));
    const asset = fn.node.scope!.node.findAll().find((node): node is Asset => node instanceof Asset && json(Stack.of(node).resolve(node.s3ObjectUrl)) === location);
    if (!asset) throw new Error(`Missing owner authorization template: ${fn.name}`);
    return readFileSync((asset.node.findChild('Stage') as AssetStaging).absoluteStagedPath, 'utf8');
  };
  for (const operation of OWNER_OPERATIONS) {
    const resolver = Object.values(backend.data.resources.cfnResources.cfnResolvers).find(item => item.fieldName === operation);
    if (!resolver) throw new Error(`Missing owner operation: ${operation}`);
    const stages = (resolver.pipelineConfig as { functions?: string[] })?.functions ?? [];
    const nativeAuth = functions.filter(fn => !fn.name.startsWith('access_') && stages.includes(fn.attrFunctionId)).map(templateFor)
      .filter(template => template.includes('cognito:groups'));
    if (!nativeAuth.some(template => template.includes('"OWNER"') && !template.includes('"ADMIN"') && !template.includes('"STAFF"') && !template.includes('"PRODUCER"'))) {
      throw new Error(`Native authorization must restrict ${operation} to Owner membership`);
    }
  }
}
