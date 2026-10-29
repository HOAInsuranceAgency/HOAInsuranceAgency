import { CfnResource, RemovalPolicy, Stack } from "aws-cdk-lib";
import { CfnResolver } from "aws-cdk-lib/aws-appsync";
import { Effect, ManagedPolicy, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { CfnFunction } from "aws-cdk-lib/aws-lambda";
import { migrationDestination, migrationPreview, migrationTargets, migrationStreamPhase, migrationSchedulesEnabled } from "./migration-config";

const READ_FUNCTIONS = new Set(["crmAccess", "communications", "commissions", "ownerProfitability"]);
const AUTH_FUNCTIONS = new Set(["magicLinkDefine", "magicLinkCreate", "magicLinkVerify", "migrationNativeMessage"]);
export const PREVIEW_DENIED_ACTIONS = [
  "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem", "dynamodb:TransactWriteItems",
  "dynamodb:PartiQLInsert", "dynamodb:PartiQLUpdate", "dynamodb:PartiQLDelete",
  "s3:PutObject", "s3:DeleteObject*", "s3:AbortMultipartUpload", "s3:RestoreObject",
  "ses:Send*", "sns:Publish", "lambda:InvokeFunction*", "textract:Start*", "textract:Analyze*", "textract:Detect*", "bedrock:Invoke*", "states:Start*",
  "secretsmanager:PutSecretValue", "secretsmanager:UpdateSecret*", "secretsmanager:CreateSecret",
  "cognito-idp:AdminCreateUser", "cognito-idp:AdminDeleteUser", "cognito-idp:AdminUpdateUserAttributes",
  "cognito-idp:AdminAddUserToGroup", "cognito-idp:AdminRemoveUserFromGroup", "cognito-idp:AdminEnableUser", "cognito-idp:AdminDisableUser",
  "cognito-idp:AdminSetUserPassword", "cognito-idp:AdminResetUserPassword", "cognito-idp:AdminConfirmSignUp",
];

/** Retain every stateful construct and resolver identity while disabling business execution. */
export function installMigrationPreview(backend: any) {
  if (!migrationDestination) return;
  // A single shared deny avoids duplicating a large policy in the already dense
  // data template. Its dependency is one-way: functions depend on this policy.
  const guard = migrationPreview ? new ManagedPolicy(backend.createStack("MigrationSafety"), "ReadOnlyBusinessFunctions", {
    statements: [new PolicyStatement({ effect: Effect.DENY, actions: PREVIEW_DENIED_ACTIONS, resources: ["*"] })],
  }) : undefined;
  for (const [name, resource] of Object.entries(backend) as [string, any][]) {
    if (!resource?.resources?.lambda || typeof resource.addEnvironment !== "function") continue;
    resource.addEnvironment("HOA_MIGRATION_PREVIEW", String(migrationPreview));
    resource.addEnvironment("HOA_MIGRATION_APP_ID", migrationTargets.crmApp);
    resource.addEnvironment("HOA_MIGRATION_BRANCH", process.env.AWS_BRANCH!);
    if (!migrationPreview || AUTH_FUNCTIONS.has(name)) continue;
    resource.resources.lambda.role!.addManagedPolicy(guard!);
    if (!READ_FUNCTIONS.has(name) && name !== "migrateProducerLicenses") {
      (resource.resources.lambda.node.defaultChild as CfnFunction).reservedConcurrentExecutions = 0;
    }
  }
  for (const node of backend.stack.node.root.node.findAll()) {
    if (node instanceof CfnResource) {
      if (["Custom::AmplifyDynamoDBTable", "AWS::DynamoDB::Table", "AWS::Cognito::UserPool", "AWS::SecretsManager::Secret"].includes(node.cfnResourceType)) node.applyRemovalPolicy(RemovalPolicy.RETAIN);
      if (node.cfnResourceType === "Custom::AmplifyDynamoDBTable") {
        node.addPropertyOverride("pointInTimeRecoverySpecification", { PointInTimeRecoveryEnabled: true });
        node.addPropertyOverride("deletionProtectionEnabled", true);
      }
      if (node.cfnResourceType === "AWS::DynamoDB::Table") {
        node.addPropertyOverride("PointInTimeRecoverySpecification", { PointInTimeRecoveryEnabled: true });
        node.addPropertyOverride("DeletionProtectionEnabled", true);
      }
      if (node.cfnResourceType === "AWS::S3::Bucket") node.addPropertyOverride("VersioningConfiguration", { Status: "Enabled" });
      if (node.cfnResourceType === "AWS::Cognito::UserPool") node.addPropertyOverride("DeletionProtection", "ACTIVE");
    }
    if (node instanceof CfnResource && node.cfnResourceType === "AWS::Lambda::EventSourceMapping") {
      if (migrationStreamPhase === "armed") {
        node.overrideLogicalId(`${Stack.of(node).getLogicalId(node)}MigrationLiveV1`);
        node.addPropertyOverride("StartingPosition", "LATEST");
        node.addPropertyOverride("Enabled", true);
      } else node.addPropertyOverride("Enabled", false);
    }
    if (node instanceof CfnResource && ["AWS::Scheduler::Schedule", "AWS::Events::Rule"].includes(node.cfnResourceType) && !migrationSchedulesEnabled) node.addPropertyOverride("State", "DISABLED");
    if (!migrationPreview) continue;
    if (node instanceof CfnResolver && node.typeName === "Mutation") {
      // Fail before the original pipeline. Keeping that pipeline and its IDs lets
      // release activation restore behavior without replacing data resources.
      if (node.runtime) {
        node.code = 'import { util } from "@aws-appsync/utils"; export function request() { util.error("Business actions are disabled in this migration preview.", "MigrationPreviewReadOnly"); } export function response(ctx) { return ctx.result; }';
        node.codeS3Location = undefined;
      } else {
        node.requestMappingTemplate = '$util.error("Business actions are disabled in this migration preview.", "MigrationPreviewReadOnly")\n' + (node.requestMappingTemplate ?? "{}");
        node.requestMappingTemplateS3Location = undefined;
      }
    }
    if (!(node instanceof CfnResource)) continue;
    switch (node.cfnResourceType) {
      case "AWS::Scheduler::Schedule":
      case "AWS::Events::Rule": node.addPropertyOverride("State", "DISABLED"); break;
      case "AWS::CloudWatch::Alarm": node.addPropertyOverride("ActionsEnabled", false); break;
      case "Custom::S3BucketNotifications":
        for (const key of ["LambdaFunctionConfigurations", "QueueConfigurations", "TopicConfigurations", "EventBridgeConfiguration"]) node.addPropertyDeletionOverride(`NotificationConfiguration.${key}`);
        break;
      case "AWS::S3::Bucket": node.addPropertyDeletionOverride("NotificationConfiguration"); break;
    }
  }
}
