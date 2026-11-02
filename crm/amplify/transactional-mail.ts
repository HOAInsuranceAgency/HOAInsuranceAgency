import { Duration } from "aws-cdk-lib";
import { Alarm, Metric, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { FunctionUrlAuthType } from "aws-cdk-lib/aws-lambda";
import { migrationDestination, migrationPreview, businessBranch } from "./migration-config";

/** Shared resources are separately retained; both backends share one free quota. */
export function installTransactionalMail(backend: any, alerts: any) {
  if (!migrationDestination) return;
  const sendingSecret = "arn:aws:secretsmanager:us-east-1:917680434255:secret:hoa/resend/sending-Z7Fxul";
  const webhookSecret = "arn:aws:secretsmanager:us-east-1:917680434255:secret:hoa/resend/webhook-7GJMl7";
  const table = "HOA-TransactionalMail";
  const tableArn = `arn:aws:dynamodb:us-east-1:917680434255:table/${table}`;
  const bucket = "hoa-transactional-mail-917680434255-us-east-1";
  const senderNames = ["magicLinkVerify", "teamAdmin", "sendInvoice", "marketingReportWorker", "stripeWebhook", "mailVerification", "mailRecovery"];
  for (const name of senderNames) {
    const fn = backend[name];
    for (const [key, value] of Object.entries({ HOA_TRANSACTIONAL_MAIL_PROVIDER: "resend", HOA_TRANSACTIONAL_MAIL_TABLE: table, HOA_TRANSACTIONAL_MAIL_BUCKET: bucket, HOA_RESEND_SECRET_ARN: sendingSecret, HOA_TRANSACTIONAL_MAIL_RELEASE: process.env.HOA_TRANSACTIONAL_MAIL_RELEASE ?? "false", HOA_RESEND_PREVIEW_ENABLED: process.env.HOA_RESEND_PREVIEW_ENABLED ?? "false" })) fn.addEnvironment(key, value);
    // The old SES grants cannot be used even if a legacy call is accidentally reintroduced.
    fn.resources.lambda.addToRolePolicy(new PolicyStatement({ effect: Effect.DENY, actions: ["ses:Send*"], resources: ["*"] }));
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
  backend.addOutput({ custom: { transactionalMail: { provider: "resend", feedbackUrl: url.url, tableName: table, outboxBucket: bucket, dailyLimit: 100, monthlyLimit: 3000 } } });
}
