import { ManagedPolicy, PolicyStatement, type IRole } from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";

/** CDK can move a large statement into an overflow managed policy, but cannot
 * split the statement's Resource array to meet IAM's 6,144-character limit.
 * Separate policies keep each exact table/index grant comfortably below it. */
export function grantAccountTableReads(scope: Construct, role: IRole, tableArns: string[]) {
  const tables = [...new Set(tableArns)].sort();
  for (let offset = 0; offset < tables.length; offset += 8) {
    const batch = tables.slice(offset, offset + 8);
    role.addManagedPolicy(new ManagedPolicy(scope, `AccountTableReads${offset / 8 + 1}`, {
      statements: [new PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query"],
        resources: [...batch, ...batch.map(arn => `${arn}/index/*`)],
      })],
    }));
  }
}
