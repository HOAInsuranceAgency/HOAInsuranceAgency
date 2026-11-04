import { ArnFormat, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Alarm, Metric, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { CfnPermission, FunctionUrlAuthType } from "aws-cdk-lib/aws-lambda";
import { SqsDestination } from "aws-cdk-lib/aws-lambda-destinations";
import { ConfigurationSet, EmailSendingEvent, EventDestination, SuppressionReasons } from "aws-cdk-lib/aws-ses";
import { Subscription, SubscriptionProtocol, Topic } from "aws-cdk-lib/aws-sns";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import { migrationDestination, migrationPreview, businessBranch } from "./migration-config";

const SES_CONFIGURATION_SET = "hoa-transactional-main";
const SES_FROM = ["noreply@protectmyhoa.com", "insurance@protectmyhoa.com"];

/** The only temporary exception is the existing owner's main login/test path. */
export function mainSesCanaryExpiry(env = process.env, now = Date.now()): string | undefined {
  const raw = env.HOA_SES_CANARY_EXPIRES_AT ?? "";
  if (!raw) return undefined;
  const expiry = Date.parse(raw);
  if (env.AWS_BRANCH !== "main" || env.AWS_APP_ID !== "d1nuh9rw1hcuxo" || env.HOA_DEPLOY_ACCOUNT_ID !== "917680434255"
    || env.HOA_MIGRATION_PREVIEW !== "false" || (env.HOA_TRANSACTIONAL_MAIL_PROVIDER ?? "resend") !== "resend"
    || (env.HOA_SES_CONFIGURATION_SET ?? SES_CONFIGURATION_SET) !== SES_CONFIGURATION_SET
    || !Number.isFinite(expiry) || !Number.isFinite(now) || expiry <= now) throw new Error("SES canary requires an unexpired, main-only HOA owner binding.");
  return new Date(expiry).toISOString();
}

function limit(raw: string | undefined, fallback: number, maximum: number): number {
  const value = raw ?? String(fallback);
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) throw new Error("Invalid HOA SES application limit.");
  return Number(value);
}

function sesSendPermissions(fn: any, canaryExpiry?: string, canarySenders = [SES_FROM[0]]) {
  const identity = Stack.of(fn.resources.lambda).formatArn({ service: "ses", resource: "identity", resourceName: "protectmyhoa.com", arnFormat: ArnFormat.SLASH_RESOURCE_NAME });
  const config = Stack.of(fn.resources.lambda).formatArn({ service: "ses", resource: "configuration-set", resourceName: SES_CONFIGURATION_SET, arnFormat: ArnFormat.SLASH_RESOURCE_NAME });
  const senders = canaryExpiry ? canarySenders : SES_FROM;
  // Older function policies include wildcard SES allows. Explicit boundaries
  // keep those old grants from widening the new provider/canary permission.
  fn.resources.lambda.addToRolePolicy(new PolicyStatement({ effect: Effect.DENY, actions: ["ses:Send*"], notResources: [identity, config] }));
  fn.resources.lambda.addToRolePolicy(new PolicyStatement({ effect: Effect.DENY, actions: ["ses:Send*"], resources: ["*"], conditions: { StringNotEquals: { "ses:FromAddress": senders } } }));
  fn.resources.lambda.addToRolePolicy(new PolicyStatement({ effect: Effect.DENY, actions: ["ses:SendRawEmail", "ses:SendBulkEmail", "ses:SendTemplatedEmail", "ses:SendBulkTemplatedEmail", "ses:SendCustomVerificationEmail", "ses:SendBounce"], resources: ["*"] }));
  if (canaryExpiry) {
    fn.resources.lambda.addToRolePolicy(new PolicyStatement({ effect: Effect.DENY, actions: ["ses:Send*"], resources: ["*"], conditions: { "ForAnyValue:StringNotEquals": { "ses:Recipients": ["jake@getgim.com"] } } }));
    fn.resources.lambda.addToRolePolicy(new PolicyStatement({ effect: Effect.DENY, actions: ["ses:Send*"], resources: ["*"], conditions: { Null: { "ses:Recipients": "true" } } }));
    fn.resources.lambda.addToRolePolicy(new PolicyStatement({ effect: Effect.DENY, actions: ["ses:Send*"], resources: ["*"], conditions: { DateGreaterThanEquals: { "aws:CurrentTime": canaryExpiry } } }));
  }
  fn.resources.lambda.addToRolePolicy(new PolicyStatement({ actions: ["ses:SendEmail"], resources: [identity, config], conditions: {
    StringEquals: { "ses:FromAddress": senders },
    ...(canaryExpiry ? { "ForAllValues:StringEquals": { "ses:Recipients": ["jake@getgim.com"] }, DateLessThan: { "aws:CurrentTime": canaryExpiry } } : {}),
  } }));
}

/** Provider changes retain shared delivery history and the Resend rollback path. */
export function installTransactionalMail(backend: any, alerts: any) {
  if (!migrationDestination) return;
  const primary = process.env.HOA_TRANSACTIONAL_MAIL_PROVIDER ?? "resend";
  if (!["resend", "ses"].includes(primary) || (primary === "ses" && (businessBranch !== "main" || migrationPreview))) throw new Error("SES production provider is approved only for the HOA main backend.");
  const canaryExpiry = mainSesCanaryExpiry();
  const sesDailyLimit = limit(process.env.HOA_SES_DAILY_LIMIT, 100, 50000);
  const sesMonthlyLimit = limit(process.env.HOA_SES_MONTHLY_LIMIT, 3000, 1500000);
  const sendingSecret = "arn:aws:secretsmanager:us-east-1:917680434255:secret:hoa/resend/sending-Z7Fxul";
  const webhookSecret = "arn:aws:secretsmanager:us-east-1:917680434255:secret:hoa/resend/webhook-7GJMl7";
  const table = "HOA-TransactionalMail";
  const tableArn = `arn:aws:dynamodb:us-east-1:917680434255:table/${table}`;
  const bucket = "hoa-transactional-mail-917680434255-us-east-1";
  const senderNames = ["magicLinkVerify", "teamAdmin", "sendInvoice", "marketingReportWorker", "stripeWebhook", "mailVerification", "mailRecovery"];
  for (const name of senderNames) {
    const fn = backend[name];
    const canarySender = canaryExpiry && ["magicLinkVerify", "mailVerification"].includes(name) ? canaryExpiry : undefined;
    for (const [key, value] of Object.entries({ HOA_TRANSACTIONAL_MAIL_PROVIDER: primary, HOA_TRANSACTIONAL_MAIL_TABLE: table, HOA_TRANSACTIONAL_MAIL_BUCKET: bucket, HOA_RESEND_SECRET_ARN: sendingSecret, HOA_TRANSACTIONAL_MAIL_RELEASE: process.env.HOA_TRANSACTIONAL_MAIL_RELEASE ?? "false", HOA_RESEND_PREVIEW_ENABLED: process.env.HOA_RESEND_PREVIEW_ENABLED ?? "false", HOA_SES_CONFIGURATION_SET: businessBranch === "main" ? SES_CONFIGURATION_SET : "hoa-transactional-staging", HOA_SES_CANARY_EXPIRES_AT: canarySender ?? "", HOA_SES_DAILY_LIMIT: String(sesDailyLimit), HOA_SES_MONTHLY_LIMIT: String(sesMonthlyLimit) })) fn.addEnvironment(key, value);
    if (primary === "ses" || canarySender) sesSendPermissions(fn, canarySender, name === "mailVerification" ? SES_FROM : [SES_FROM[0]]);
    else fn.resources.lambda.addToRolePolicy(new PolicyStatement({ effect: Effect.DENY, actions: ["ses:Send*"], resources: ["*"] }));
    const ownerTest = migrationPreview && ["magicLinkVerify", "mailVerification"].includes(name) && businessBranch === "main" && process.env.HOA_PREVIEW_ADMIN_LOGIN === "true" && process.env.HOA_RESEND_PREVIEW_ENABLED === "true";
    const expiry = process.env.HOA_PREVIEW_ADMIN_LOGIN_EXPIRES_AT;
    if (ownerTest && (!expiry || !Number.isFinite(Date.parse(expiry)))) throw new Error("Resend preview tests require an exact expiry.");
    if (!migrationPreview || ownerTest) {
      fn.resources.lambda.addToRolePolicy(new PolicyStatement({ actions: ["secretsmanager:GetSecretValue"], resources: [sendingSecret], ...(ownerTest ? { conditions: { DateLessThan: { "aws:CurrentTime": expiry! } } } : {}) }));
    } else fn.resources.lambda.addToRolePolicy(new PolicyStatement({ effect: Effect.DENY, actions: ["secretsmanager:GetSecretValue"], resources: [sendingSecret] }));
    fn.resources.lambda.addToRolePolicy(new PolicyStatement({ actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"], resources: [tableArn] }));
    fn.resources.lambda.addToRolePolicy(new PolicyStatement({ actions: ["s3:PutObject"], resources: [`arn:aws:s3:::${bucket}/outbox/${businessBranch}/*`] }));
    if (name === "mailRecovery") {
      fn.addEnvironment("HOA_TRANSACTIONAL_MAIL_RECOVERY_ENABLED", process.env.HOA_TRANSACTIONAL_MAIL_RECOVERY_ENABLED ?? "false");
      fn.resources.lambda.addToRolePolicy(new PolicyStatement({ actions: ["s3:GetObject"], resources: [`arn:aws:s3:::${bucket}/outbox/${businessBranch}/*`] }));
    }
    if (name === "mailVerification") for (const key of ["HOA_PREVIEW_ADMIN_LOGIN", "HOA_PREVIEW_ADMIN_EMAIL", "HOA_PREVIEW_ADMIN_LOGIN_EXPIRES_AT"]) fn.addEnvironment(key, process.env[key] ?? "");
  }
  // Feedback processes only authenticated provider events; it cannot send mail or access CRM data.
  const feedback = backend.mailFeedback;
  feedback.addEnvironment("HOA_TRANSACTIONAL_MAIL_PROVIDER", "resend");
  feedback.addEnvironment("HOA_TRANSACTIONAL_MAIL_TABLE", table);
  feedback.addEnvironment("RESEND_WEBHOOK_SECRET_ARN", webhookSecret);
  feedback.resources.lambda.addToRolePolicy(new PolicyStatement({ actions: ["secretsmanager:GetSecretValue"], resources: [webhookSecret] }));
  feedback.resources.lambda.addToRolePolicy(new PolicyStatement({ effect: Effect.DENY, actions: ["secretsmanager:GetSecretValue"], resources: [sendingSecret] }));
  feedback.resources.lambda.addToRolePolicy(new PolicyStatement({ actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"], resources: [tableArn], conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["EVENT#*", "RECEIPT#*", "SUPPRESSION#*"] } } }));
  const url = feedback.resources.lambda.addFunctionUrl({ authType: FunctionUrlAuthType.NONE });
  const alarm = new Alarm(backend.createStack("TransactionalMail"), "NeedsReview", { alarmDescription: "HOA transactional email is deferred, rejected, suppressed, or uncertain. Review the durable mail ledger and outbox; do not blindly resend.", metric: new Metric({ namespace: "HOA/TransactionalMail", metricName: "DeliveryNeedsReview", dimensionsMap: { Environment: businessBranch }, period: Duration.minutes(1), statistic: "Sum" }), threshold: 1, evaluationPeriods: 1, treatMissingData: TreatMissingData.NOT_BREACHING });
  alarm.addAlarmAction(new SnsAction(alerts));
  if (businessBranch === "main" && !migrationPreview) {
    const sesFeedback = backend.sesMailFeedback;
    if (!sesFeedback?.resources?.lambda) throw new Error("Main SES feedback resource is missing.");
    // This new resource group keeps the existing data template and resource IDs stable.
    const sesStack = Stack.of(sesFeedback.resources.lambda);
    const topic = new Topic(sesStack, "FeedbackTopic", { topicName: "hoa-transactional-main-feedback" });
    const config = new ConfigurationSet(sesStack, "ConfigurationSet", { configurationSetName: SES_CONFIGURATION_SET, reputationMetrics: true, sendingEnabled: true, suppressionReasons: SuppressionReasons.BOUNCES_AND_COMPLAINTS });
    config.addEventDestination("FeedbackEvents", { configurationSetEventDestinationName: "hoa-transactional-main-feedback", destination: EventDestination.snsTopic(topic), events: [EmailSendingEvent.SEND, EmailSendingEvent.REJECT, EmailSendingEvent.BOUNCE, EmailSendingEvent.COMPLAINT, EmailSendingEvent.DELIVERY, EmailSendingEvent.RENDERING_FAILURE, EmailSendingEvent.DELIVERY_DELAY] });
    const failed = new Queue(sesStack, "FeedbackFailureQueue", { encryption: QueueEncryption.SQS_MANAGED, retentionPeriod: Duration.days(14), removalPolicy: RemovalPolicy.RETAIN });
    const permission = new CfnPermission(sesStack, "TopicInvocation", { action: "lambda:InvokeFunction", principal: "sns.amazonaws.com", functionName: sesFeedback.resources.lambda.functionName, sourceArn: topic.topicArn, sourceAccount: "917680434255" });
    const subscription = new Subscription(sesStack, "FeedbackSubscription", { topic, protocol: SubscriptionProtocol.LAMBDA, endpoint: sesFeedback.resources.lambda.functionArn, deadLetterQueue: failed });
    subscription.node.addDependency(permission);
    sesFeedback.resources.lambda.configureAsyncInvoke({ maxEventAge: Duration.hours(6), retryAttempts: 2, onFailure: new SqsDestination(failed) });
    for (const [key, value] of Object.entries({ HOA_TRANSACTIONAL_MAIL_PROVIDER: "ses", HOA_TRANSACTIONAL_MAIL_TABLE: table, HOA_SES_CONFIGURATION_SET: SES_CONFIGURATION_SET, HOA_SES_FEEDBACK_TOPIC_ARN: topic.topicArn })) sesFeedback.addEnvironment(key, value);
    sesFeedback.resources.lambda.addToRolePolicy(new PolicyStatement({ effect: Effect.DENY, actions: ["ses:Send*", "secretsmanager:GetSecretValue"], resources: ["*"] }));
    sesFeedback.resources.lambda.addToRolePolicy(new PolicyStatement({ actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"], resources: [tableArn], conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["EVENT#ses#*", "RECEIPT#ses#*", "SUPPRESSION#*", "OP#hoa/main/*"] } } }));
    const failedAlarm = new Alarm(sesStack, "FeedbackFailureAlarm", { metric: failed.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1), statistic: "Maximum" }), threshold: 1, evaluationPeriods: 1, treatMissingData: TreatMissingData.NOT_BREACHING, alarmDescription: "SES feedback could not be processed. Preserve and review the private failure queue; never replay customer emails from it." });
    failedAlarm.addAlarmAction(new SnsAction(alerts));
    const processingAlarm = new Alarm(sesStack, "FeedbackProcessingErrors", { metric: sesFeedback.resources.lambda.metricErrors({ period: Duration.minutes(1), statistic: "Sum" }), threshold: 1, evaluationPeriods: 1, treatMissingData: TreatMissingData.NOT_BREACHING, alarmDescription: "SES feedback processing failed. Check its logs and retained failure queue without replaying customer mail." });
    processingAlarm.addAlarmAction(new SnsAction(alerts));
    const notificationAlarm = new Alarm(sesStack, "FeedbackNotificationFailures", { metric: topic.metricNumberOfNotificationsFailed({ period: Duration.minutes(1), statistic: "Sum" }), threshold: 1, evaluationPeriods: 1, treatMissingData: TreatMissingData.NOT_BREACHING, alarmDescription: "SNS could not invoke the SES feedback processor. Check topic permissions and the retained failure queue." });
    notificationAlarm.addAlarmAction(new SnsAction(alerts));
  }
  backend.addOutput({ custom: { transactionalMail: { provider: primary, feedbackUrl: url.url, tableName: table, outboxBucket: bucket, dailyLimit: primary === "ses" ? sesDailyLimit : 100, monthlyLimit: primary === "ses" ? sesMonthlyLimit : 3000 } } });
}
