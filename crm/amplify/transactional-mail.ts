import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Alarm, Metric, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { Effect, ManagedPolicy, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { CfnPermission } from "aws-cdk-lib/aws-lambda";
import { SqsDestination } from "aws-cdk-lib/aws-lambda-destinations";
import { ConfigurationSet, EmailSendingEvent, EventDestination, SuppressionReasons } from "aws-cdk-lib/aws-ses";
import { Subscription, SubscriptionProtocol, Topic } from "aws-cdk-lib/aws-sns";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import { migrationDestination, migrationPreview, businessBranch } from "./migration-config";

const SES_IDENTITY_ARN = "arn:aws:ses:us-east-1:917680434255:identity/protectmyhoa.com";
const MAIN_FROM = ["noreply@protectmyhoa.com", "insurance@protectmyhoa.com"];
const STAGING_FROM = ["noreply@protectmyhoa.com", "jake+testing@protectmyhoa.com"];

function limit(raw: string | undefined, fallback: number, maximum: number): number {
  const value = raw ?? String(fallback);
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) throw new Error("Invalid HOA SES application limit.");
  return Number(value);
}

function sesSendPermissions(configurationSet: string, staging: boolean): PolicyStatement[] {
  const config = `arn:aws:ses:us-east-1:917680434255:configuration-set/${configurationSet}`;
  const senders = staging ? STAGING_FROM : MAIN_FROM;
  // Older function policies include wildcard SES allows. Explicit boundaries
  // keep those old grants from widening the approved sender and branch scope.
  const statements = [
    new PolicyStatement({ effect: Effect.DENY, actions: ["ses:Send*"], notResources: [SES_IDENTITY_ARN, config] }),
    new PolicyStatement({ effect: Effect.DENY, actions: ["ses:Send*"], resources: ["*"], conditions: { StringNotEquals: { "ses:FromAddress": senders } } }),
    new PolicyStatement({ effect: Effect.DENY, actions: ["ses:SendRawEmail", "ses:SendBulkEmail", "ses:SendTemplatedEmail", "ses:SendBulkTemplatedEmail", "ses:SendCustomVerificationEmail", "ses:SendBounce"], resources: ["*"] }),
  ];
  if (staging) {
    statements.push(new PolicyStatement({ effect: Effect.DENY, actions: ["ses:Send*"], resources: ["*"], conditions: { "ForAnyValue:StringNotEquals": { "ses:Recipients": ["jake@getgim.com"] } } }));
    statements.push(new PolicyStatement({ effect: Effect.DENY, actions: ["ses:Send*"], resources: ["*"], conditions: { Null: { "ses:Recipients": "true" } } }));
  }
  statements.push(new PolicyStatement({ actions: ["ses:SendEmail"], resources: [SES_IDENTITY_ARN, config], conditions: {
    StringEquals: { "ses:FromAddress": senders },
    ...(staging ? { "ForAllValues:StringEquals": { "ses:Recipients": ["jake@getgim.com"] } } : {}),
  } }));
  return statements;
}

/** Both environments use SES while retaining the shared delivery history. */
export function installTransactionalMail(backend: any, alerts: any) {
  if (!migrationDestination) return;
  if ((process.env.HOA_TRANSACTIONAL_MAIL_PROVIDER ?? "ses") !== "ses" || !["main", "staging"].includes(businessBranch)) throw new Error("HOA transactional email requires its approved SES backend.");
  const staging = businessBranch === "staging";
  const configurationSet = `hoa-transactional-${businessBranch}`;
  const sesDailyLimit = limit(process.env.HOA_SES_DAILY_LIMIT, 100, 50000);
  const sesMonthlyLimit = limit(process.env.HOA_SES_MONTHLY_LIMIT, 3000, 1500000);
  const table = "HOA-TransactionalMail";
  const tableArn = `arn:aws:dynamodb:us-east-1:917680434255:table/${table}`;
  const bucket = "hoa-transactional-mail-917680434255-us-east-1";
  // The data template is near CloudFormation's limit. One independent policy
  // shares the complete boundary without referencing roles, alerts or topics.
  const permissionsStack = !migrationPreview ? backend.createStack("TransactionalMailSendPermissions") : undefined;
  const sendPermissions = permissionsStack ? new ManagedPolicy(permissionsStack, "SesSendPermissions", { statements: sesSendPermissions(configurationSet, staging) }) : undefined;
  // Void may retire only invoice OP keys in its own environment. It cannot
  // send mail, edit counters/receipts, or access saved envelopes.
  for(const fn of [backend.voidInvoice,backend.crmAccess,backend.pfElection])fn.addEnvironment('HOA_TRANSACTIONAL_MAIL_TABLE',table);
  if(permissionsStack)new ManagedPolicy(backend.createStack('InvoiceSendRetirementPermissions'),'InvoiceVoidMailRetirement',{roles:[backend.voidInvoice.resources.lambda.role!,backend.crmAccess.resources.lambda.role!,backend.pfElection.resources.lambda.role!],statements:[new PolicyStatement({actions:['dynamodb:GetItem','dynamodb:UpdateItem'],resources:[tableArn],conditions:{'ForAllValues:StringLike':{'dynamodb:LeadingKeys':[`OP#hoa/${businessBranch}/invoice/*`]}}})]});
  const senderNames = ["magicLinkVerify", "teamAdmin", "sendInvoice", "marketingReportWorker", "stripeWebhook", "mailVerification", "mailRecovery"];
  for (const name of senderNames) {
    const fn = backend[name];
    for (const [key, value] of Object.entries({ HOA_TRANSACTIONAL_MAIL_PROVIDER: "ses", HOA_TRANSACTIONAL_MAIL_TABLE: table, HOA_TRANSACTIONAL_MAIL_BUCKET: bucket, HOA_TRANSACTIONAL_MAIL_RELEASE: process.env.HOA_TRANSACTIONAL_MAIL_RELEASE ?? "false", HOA_SES_IDENTITY_ARN: SES_IDENTITY_ARN, HOA_SES_CONFIGURATION_SET: configurationSet, HOA_SES_DAILY_LIMIT: String(sesDailyLimit), HOA_SES_MONTHLY_LIMIT: String(sesMonthlyLimit) })) fn.addEnvironment(key, value);
    if (sendPermissions) fn.resources.lambda.role!.addManagedPolicy(sendPermissions);
    else fn.resources.lambda.addToRolePolicy(new PolicyStatement({ effect: Effect.DENY, actions: ["ses:Send*"], resources: ["*"] }));
    fn.resources.lambda.addToRolePolicy(new PolicyStatement({ actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"], resources: [tableArn] }));
    fn.resources.lambda.addToRolePolicy(new PolicyStatement({ actions: ["s3:PutObject"], resources: [`arn:aws:s3:::${bucket}/outbox/${businessBranch}/*`] }));
    if (name === "mailRecovery") {
      fn.addEnvironment("HOA_TRANSACTIONAL_MAIL_RECOVERY_ENABLED", process.env.HOA_TRANSACTIONAL_MAIL_RECOVERY_ENABLED ?? "false");
      fn.resources.lambda.addToRolePolicy(new PolicyStatement({ actions: ["s3:GetObject"], resources: [`arn:aws:s3:::${bucket}/outbox/${businessBranch}/*`] }));
    }
    if (name === "mailVerification") fn.addEnvironment("HOA_SES_VERIFICATION_EXPIRES_AT", process.env.HOA_SES_VERIFICATION_EXPIRES_AT ?? "");
  }
  const alarm = new Alarm(backend.createStack("TransactionalMail"), "NeedsReview", { alarmDescription: "HOA transactional email is deferred, rejected, suppressed, or uncertain. Review the durable mail ledger and outbox; do not blindly resend.", metric: new Metric({ namespace: "HOA/TransactionalMail", metricName: "DeliveryNeedsReview", dimensionsMap: { Environment: businessBranch }, period: Duration.minutes(1), statistic: "Sum" }), threshold: 1, evaluationPeriods: 1, treatMissingData: TreatMissingData.NOT_BREACHING });
  alarm.addAlarmAction(new SnsAction(alerts));
  if (!migrationPreview) {
    const sesFeedback = backend.sesMailFeedback;
    if (!sesFeedback?.resources?.lambda) throw new Error("SES feedback resource is missing.");
    // This new resource group keeps the existing data template and resource IDs stable.
    const sesStack = Stack.of(sesFeedback.resources.lambda);
    const topic = new Topic(sesStack, "FeedbackTopic", { topicName: `${configurationSet}-feedback` });
    const config = new ConfigurationSet(sesStack, "ConfigurationSet", { configurationSetName: configurationSet, reputationMetrics: true, sendingEnabled: true, suppressionReasons: SuppressionReasons.BOUNCES_AND_COMPLAINTS });
    config.addEventDestination("FeedbackEvents", { configurationSetEventDestinationName: `${configurationSet}-feedback`, destination: EventDestination.snsTopic(topic), events: [EmailSendingEvent.SEND, EmailSendingEvent.REJECT, EmailSendingEvent.BOUNCE, EmailSendingEvent.COMPLAINT, EmailSendingEvent.DELIVERY, EmailSendingEvent.RENDERING_FAILURE, EmailSendingEvent.DELIVERY_DELAY] });
    const failed = new Queue(sesStack, "FeedbackFailureQueue", { encryption: QueueEncryption.SQS_MANAGED, retentionPeriod: Duration.days(14), removalPolicy: RemovalPolicy.RETAIN });
    const permission = new CfnPermission(sesStack, "TopicInvocation", { action: "lambda:InvokeFunction", principal: "sns.amazonaws.com", functionName: sesFeedback.resources.lambda.functionName, sourceArn: topic.topicArn, sourceAccount: "917680434255" });
    const subscription = new Subscription(sesStack, "FeedbackSubscription", { topic, protocol: SubscriptionProtocol.LAMBDA, endpoint: sesFeedback.resources.lambda.functionArn, deadLetterQueue: failed });
    subscription.node.addDependency(permission);
    sesFeedback.resources.lambda.configureAsyncInvoke({ maxEventAge: Duration.hours(6), retryAttempts: 2, onFailure: new SqsDestination(failed) });
    for (const [key, value] of Object.entries({ HOA_TRANSACTIONAL_MAIL_PROVIDER: "ses", HOA_TRANSACTIONAL_MAIL_TABLE: table, HOA_SES_CONFIGURATION_SET: configurationSet, HOA_SES_FEEDBACK_TOPIC_ARN: topic.topicArn })) sesFeedback.addEnvironment(key, value);
    sesFeedback.resources.lambda.addToRolePolicy(new PolicyStatement({ effect: Effect.DENY, actions: ["ses:Send*", "secretsmanager:GetSecretValue"], resources: ["*"] }));
    sesFeedback.resources.lambda.addToRolePolicy(new PolicyStatement({ actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"], resources: [tableArn], conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["EVENT#ses#*", "RECEIPT#ses#*", "SUPPRESSION#*", `OP#hoa/${businessBranch}/*`] } } }));
    const failedAlarm = new Alarm(sesStack, "FeedbackFailureAlarm", { metric: failed.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1), statistic: "Maximum" }), threshold: 1, evaluationPeriods: 1, treatMissingData: TreatMissingData.NOT_BREACHING, alarmDescription: "SES feedback could not be processed. Preserve and review the private failure queue; never replay customer emails from it." });
    failedAlarm.addAlarmAction(new SnsAction(alerts));
    const processingAlarm = new Alarm(sesStack, "FeedbackProcessingErrors", { metric: sesFeedback.resources.lambda.metricErrors({ period: Duration.minutes(1), statistic: "Sum" }), threshold: 1, evaluationPeriods: 1, treatMissingData: TreatMissingData.NOT_BREACHING, alarmDescription: "SES feedback processing failed. Check its logs and retained failure queue without replaying customer mail." });
    processingAlarm.addAlarmAction(new SnsAction(alerts));
    const notificationAlarm = new Alarm(sesStack, "FeedbackNotificationFailures", { metric: topic.metricNumberOfNotificationsFailed({ period: Duration.minutes(1), statistic: "Sum" }), threshold: 1, evaluationPeriods: 1, treatMissingData: TreatMissingData.NOT_BREACHING, alarmDescription: "SNS could not invoke the SES feedback processor. Check topic permissions and the retained failure queue." });
    notificationAlarm.addAlarmAction(new SnsAction(alerts));
  }
  backend.addOutput({ custom: { transactionalMail: { provider: "ses", tableName: table, outboxBucket: bucket, dailyLimit: sesDailyLimit, monthlyLimit: sesMonthlyLimit } } });
}
