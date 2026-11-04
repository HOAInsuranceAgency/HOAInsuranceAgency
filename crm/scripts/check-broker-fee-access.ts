import { CfnResource, Stack } from 'aws-cdk-lib';
import type { IRole } from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

type Statement = { Effect?: string; Action?: string | string[]; Resource?: unknown | unknown[]; Condition?: unknown };
type Document = { Statement?: Statement[] };
type Resource = { Type: string; Properties?: { Roles?: unknown[]; RoleName?: unknown; PolicyDocument?: Document; Policies?: { PolicyDocument?: Document }[] } };

/** Shared void code executes inside each caller's role. Inspect the rendered
 * policies, including the separate permissions stack, rather than a grant list.
 * Serializing existing references avoids adding cross-stack dependencies. */
export function checkBrokerFeeCallerAccess(root: Construct, callers: Record<string, IRole>) {
  const nodes = root.node.findAll().filter((node): node is CfnResource => node instanceof CfnResource);
  for (const [name, role] of Object.entries(callers)) {
    const nativeRole = role.node.defaultChild;
    if (!(nativeRole instanceof CfnResource)) throw new Error(`${name} has no inspectable execution role`);
    const roleId = Stack.of(nativeRole).getLogicalId(nativeRole);
    // Nested-stack output names retain this unique construct stem, even when
    // CDK changes the export's hash suffix.
    const roleStem = roleId.replace(/[A-F0-9]{8}$/, '');
    const referencesRole = (value: unknown) => JSON.stringify(value)?.includes(roleStem) === true;
    const actions = new Set<string>();
    for (const node of nodes) {
      const resource = Object.values(Stack.of(node).resolve(node._toCloudFormation()).Resources as Record<string, Resource>)[0];
      const props = resource.Properties;
      const documents = resource.Type === 'AWS::IAM::Role' && node === nativeRole
        ? (props?.Policies ?? []).flatMap(policy => policy.PolicyDocument ? [policy.PolicyDocument] : [])
        : ['AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy'].includes(resource.Type) && props?.Roles?.some(referencesRole)
          || resource.Type === 'AWS::IAM::RolePolicy' && referencesRole(props?.RoleName)
          ? props?.PolicyDocument ? [props.PolicyDocument] : [] : [];
      for (const statement of documents.flatMap(document => document.Statement ?? [])) {
        if (statement.Effect !== 'Allow' || statement.Condition || ![statement.Resource].flat().some(arn => JSON.stringify(arn)?.includes('BrokerFeeLedger'))) continue;
        for (const action of [statement.Action].flat()) if (typeof action === 'string') actions.add(action);
      }
    }
    for (const action of ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:ConditionCheckItem']) {
      if (!actions.has(action) && !actions.has('dynamodb:*') && !actions.has('*')) throw new Error(`${name} lacks broker fee claim-release permission: ${action}`);
    }
  }
}
