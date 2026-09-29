// @vitest-environment node
import { expect, it } from "vitest";
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { CfnGraphQLApi } from "aws-cdk-lib/aws-appsync";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { grantAccountTableReads } from "../../amplify/account-access-policies";
import { ACCOUNT_MODELS, SHARED_MODELS } from "../../amplify/functions/crm-access/policy";
import { crmPolicySize } from "../../scripts/iam-policy-size";

it("keeps the same exact read permissions in bounded, attached managed policies", () => {
  const stack = new Stack(new App(), "PolicyTest", { env: { account: "123456789012", region: "us-east-1" } });
  const role = new Role(stack, "Role", { assumedBy: new ServicePrincipal("lambda.amazonaws.com") });
  const api = new CfnGraphQLApi(stack, "Api", { name: "CRM", authenticationType: "AWS_IAM" });
  const arns = [...ACCOUNT_MODELS, ...SHARED_MODELS].map(model => stack.formatArn({ service: "dynamodb", resource: "table", resourceName: `${model}-${api.attrApiId}-NONE` }));
  grantAccountTableReads(stack, role, [...arns, arns[0]]);
  const template = Template.fromStack(stack);
  const policies = Object.values(template.findResources("AWS::IAM::ManagedPolicy"));
  expect(policies).toHaveLength(Math.ceil(arns.length / 8));
  const resources: unknown[] = [];
  for (const policy of policies) {
    expect(crmPolicySize(policy.Properties.PolicyDocument)).toBeLessThan(6144);
    const statements = policy.Properties.PolicyDocument.Statement;
    expect(statements).toHaveLength(1);
    expect(statements[0].Effect).toBe("Allow");
    expect(new Set(statements[0].Action)).toEqual(new Set(["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query"]));
    expect(statements[0].Resource.length).toBeLessThanOrEqual(16);
    resources.push(...statements[0].Resource);
  }
  expect(new Set(resources.map(r => JSON.stringify(r)))).toEqual(new Set(arns.flatMap(arn => [arn, `${arn}/index/*`]).map(r => JSON.stringify(stack.resolve(r)))));
  const roleProperties = Object.values(template.findResources("AWS::IAM::Role"))[0].Properties;
  expect(new Set(roleProperties.ManagedPolicyArns.map((arn: { Ref: string }) => arn.Ref))).toEqual(new Set(Object.keys(template.findResources("AWS::IAM::ManagedPolicy"))));
  expect(template.findResources("AWS::IAM::Policy")).toEqual({});
});

it("detects the original oversized statement after expanding deployment references", () => {
  const resources = [...ACCOUNT_MODELS, ...SHARED_MODELS].flatMap(model => ["", "/index/*"].map(suffix => ({ "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":dynamodb:", { Ref: "AWS::Region" }, ":", { Ref: "AWS::AccountId" }, `:table/${model}-`, { "Fn::GetAtt": ["Api", "ApiId"] }, `-NONE${suffix}`]] })));
  const policy = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query"], Resource: resources }] };
  expect(crmPolicySize(policy)).toBeGreaterThan(6144);
  for (let offset = 0; offset < resources.length; offset += 16) {
    expect(crmPolicySize({ ...policy, Statement: [{ ...policy.Statement[0], Resource: resources.slice(offset, offset + 16) }] })).toBeLessThan(6144);
  }
});

it("does not underestimate generated ARN references or ignore unsupported expressions", () => {
  expect(crmPolicySize({ Resource: { "Fn::GetAtt": ["Table", "Arn"] } })).toBeGreaterThan(512);
  expect(crmPolicySize({ Resource: { Ref: "GeneratedTableName" } })).toBeGreaterThan(256);
  expect(() => crmPolicySize({ Resource: { "Fn::Sub": "arn:${Partition}:..." } })).toThrow("Unsupported CRM policy expression");
});
