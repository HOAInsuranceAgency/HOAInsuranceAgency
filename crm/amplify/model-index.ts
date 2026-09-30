import { CfnResource, Stack } from "aws-cdk-lib";
import type { Construct } from "constructs";

/** Read Amplify's generated name instead of assuming a GSI naming convention. */
export function modelIndex(scope: Construct, model: string, partitionKey: string) {
  const resource = scope.node.root.node.findAll().find((node): node is CfnResource =>
    node instanceof CfnResource && node.cfnResourceType === "Custom::AmplifyDynamoDBTable" &&
    node.node.path.endsWith(`/${model}/${model}Table/Default/Default`)
  );
  if (!resource) throw new Error(`Missing generated table for ${model}`);
  type Index = { indexName: string; keySchema: { attributeName: string; keyType: string }[] };
  const template = Stack.of(resource).resolve(resource._toCloudFormation());
  const properties = Object.values(template.Resources as Record<string, { Properties: { globalSecondaryIndexes?: Index[] } }>)[0].Properties;
  const index = properties.globalSecondaryIndexes?.find(candidate =>
    candidate.keySchema.length === 1 && candidate.keySchema[0].attributeName === partitionKey && candidate.keySchema[0].keyType === "HASH"
  );
  if (!index) throw new Error(`Missing ${model}.${partitionKey} index`);
  return { resource, name: index.indexName };
}
