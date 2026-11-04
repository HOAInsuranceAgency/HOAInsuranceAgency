// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { Function, Code, Runtime } from "aws-cdk-lib/aws-lambda";
import { Topic } from "aws-cdk-lib/aws-sns";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";

const config = vi.hoisted(() => ({ migrationDestination: true, migrationPreview: false, businessBranch: "main" }));
vi.mock("../../amplify/migration-config", () => config);
import { installTransactionalMail, mainSesCanaryExpiry } from "../../amplify/transactional-mail";
const now = Date.parse("2026-11-04T02:00:00Z");
const expiry = "2026-11-04T03:00:00.000Z";
const validEnv = { AWS_BRANCH: "main", AWS_APP_ID: "d1nuh9rw1hcuxo", HOA_DEPLOY_ACCOUNT_ID: "917680434255", HOA_MIGRATION_PREVIEW: "false", HOA_TRANSACTIONAL_MAIL_PROVIDER: "resend", HOA_SES_CONFIGURATION_SET: "hoa-transactional-main", HOA_SES_CANARY_EXPIRES_AT: expiry };
const senders = ["magicLinkVerify", "teamAdmin", "sendInvoice", "marketingReportWorker", "stripeWebhook", "mailVerification", "mailRecovery"];
function infra() {
  const app = new App(); const stack = new Stack(app, "ExistingMail", { env: { account: "917680434255", region: "us-east-1" } });
  const sesStack = new Stack(app, "NewSesMail", { env: { account: "917680434255", region: "us-east-1" } });
  const backend: any = { createStack: (name: string) => new Stack(app, name, { env: { account: "917680434255", region: "us-east-1" } }), addOutput: vi.fn() };
  for (const name of [...senders, "mailFeedback", "sesMailFeedback"]) {
    const fn = new Function(name === "sesMailFeedback" ? sesStack : stack, name, { runtime: Runtime.NODEJS_22_X, handler: "index.handler", code: Code.fromInline("exports.handler=async()=>({});") });
    if (senders.includes(name)) fn.addToRolePolicy(new PolicyStatement({ actions: ["ses:SendEmail"], resources: ["*"] }));
    backend[name] = { resources: { lambda: fn }, addEnvironment: (key: string, value: string) => fn.addEnvironment(key, value) };
  }
  const alerts = new Topic(stack, "ExistingAlertTopic");
  installTransactionalMail(backend, alerts);
  return { backend, existing: Template.fromStack(stack).toJSON(), ses: Template.fromStack(sesStack).toJSON() };
}
function statements(template: any) { return Object.values(template.Resources).filter((r: any) => r.Type === "AWS::IAM::Policy").flatMap((r: any) => r.Properties.PolicyDocument.Statement); }
function mailFunction(template: any, name: string): any {
  return Object.entries(template.Resources).find(([id, r]: [string, any]) => r.Type === "AWS::Lambda::Function" && id.startsWith(name))?.[1];
}
beforeEach(() => {
  config.migrationDestination = true; config.migrationPreview = false; config.businessBranch = "main";
  for (const [key, value] of Object.entries({ ...validEnv, HOA_SES_CANARY_EXPIRES_AT: "", HOA_SES_DAILY_LIMIT: "100", HOA_SES_MONTHLY_LIMIT: "3000" })) vi.stubEnv(key, value);
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("main-only expiring SES canary", () => {
  it("returns no exception when it is closed", () => expect(mainSesCanaryExpiry({ ...validEnv, HOA_SES_CANARY_EXPIRES_AT: "" }, now)).toBeUndefined());
  it("accepts only the exact unexpired main binding", () => expect(mainSesCanaryExpiry(validEnv, now)).toBe(expiry));
  it.each([
    { AWS_BRANCH: "staging" }, { AWS_APP_ID: "other-app" }, { HOA_DEPLOY_ACCOUNT_ID: "637423611040" },
    { HOA_MIGRATION_PREVIEW: "true" }, { HOA_TRANSACTIONAL_MAIL_PROVIDER: "ses" }, { HOA_SES_CONFIGURATION_SET: "other-config" },
    { HOA_SES_CANARY_EXPIRES_AT: "invalid" }, { HOA_SES_CANARY_EXPIRES_AT: new Date(now).toISOString() },
  ])("rejects an incorrect or expired binding %j", override => expect(() => mainSesCanaryExpiry({ ...validEnv, ...override }, now)).toThrow());
  it("closes at the exact deadline", () => expect(() => mainSesCanaryExpiry(validEnv, Date.parse(expiry))).toThrow());
});

describe("SES infrastructure and rollback boundaries", () => {
  it("keeps Resend primary and all non-canary senders denied by default", () => {
    const { existing, backend } = infra();
    for (const name of senders) {
      const fn = mailFunction(existing, name); expect(fn.Properties.Environment.Variables.HOA_TRANSACTIONAL_MAIL_PROVIDER).toBe("resend");
      expect(fn.Properties.Environment.Variables.HOA_RESEND_SECRET_ARN).toContain(":secret:hoa/resend/sending-");
      expect(fn.Properties.Environment.Variables.HOA_SES_CANARY_EXPIRES_AT).toBe("");
    }
    expect(statements(existing).filter((s: any) => s.Effect === "Deny" && s.Action === "ses:Send*" && s.Resource === "*" && !s.Condition)).toHaveLength(7);
    expect(mailFunction(existing, "mailFeedback").Properties.Environment.Variables.HOA_TRANSACTIONAL_MAIL_PROVIDER).toBe("resend");
    expect(JSON.stringify(existing)).toContain("hoa/resend/webhook-");
    expect(Object.values(existing.Resources).filter((r: any) => r.Type === "AWS::Lambda::Url")).toHaveLength(1);
    expect(backend.addOutput).toHaveBeenCalledWith({ custom: { transactionalMail: expect.objectContaining({ provider: "resend", dailyLimit: 100, monthlyLimit: 3000 }) } });
  });
  it("binds SES publishing and Lambda invocation to exact account/config/topic", () => {
    const { ses } = infra(); const resources = Object.values(ses.Resources) as any[];
    expect(resources.filter(r => r.Type === "AWS::SES::ConfigurationSet")).toHaveLength(1);
    expect(resources.find(r => r.Type === "AWS::SES::ConfigurationSet").Properties.Name).toBe("hoa-transactional-main");
    const policy = resources.find(r => r.Type === "AWS::SNS::TopicPolicy").Properties.PolicyDocument.Statement;
    expect(policy).toHaveLength(1); expect(policy[0].Principal).toEqual({ Service: "ses.amazonaws.com" });
    expect(policy[0].Condition.StringEquals["AWS:SourceAccount"]).toBe("917680434255");
    const configId = Object.entries(ses.Resources).find(([, r]: [string, any]) => r.Type === "AWS::SES::ConfigurationSet")![0];
    expect(policy[0].Condition.StringEquals["AWS:SourceArn"]).toEqual({ "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":ses:us-east-1:917680434255:configuration-set/", { Ref: configId }]] });
    const permission = resources.find(r => r.Type === "AWS::Lambda::Permission").Properties;
    expect(permission.Principal).toBe("sns.amazonaws.com"); expect(permission.SourceAccount).toBe("917680434255"); expect(permission.SourceArn).toBeDefined();
    expect(resources.filter(r => r.Type === "AWS::Lambda::Url")).toHaveLength(0);
    expect(resources.filter(r => r.Type === "AWS::Lambda::EventSourceMapping")).toHaveLength(0);
  });
  it("retains encrypted failed feedback without an automatic consumer", () => {
    const { ses } = infra(); const resources = Object.values(ses.Resources) as any[]; const queue = resources.find(r => r.Type === "AWS::SQS::Queue");
    expect(queue.Properties.SqsManagedSseEnabled).toBe(true); expect(queue.Properties.MessageRetentionPeriod).toBe(14 * 24 * 60 * 60);
    expect(queue.DeletionPolicy).toBe("Retain"); expect(queue.UpdateReplacePolicy).toBe("Retain");
    const asynchronous = resources.find(r => r.Type === "AWS::Lambda::EventInvokeConfig").Properties;
    expect(asynchronous.MaximumRetryAttempts).toBe(2); expect(asynchronous.MaximumEventAgeInSeconds).toBe(6 * 60 * 60); expect(asynchronous.DestinationConfig.OnFailure.Destination).toBeDefined();
    expect(resources.find(r => r.Type === "AWS::SNS::Subscription").Properties.RedrivePolicy.deadLetterTargetArn).toBeDefined();
    expect(resources.filter(r => r.Type === "AWS::CloudWatch::Alarm")).toHaveLength(3);
  });
  it("permits canary roles only under recipient, sender, account and expiry boundaries", () => {
    vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv("HOA_SES_CANARY_EXPIRES_AT", expiry);
    const { existing } = infra(); const policies = Object.entries(existing.Resources).filter(([, r]: [string, any]) => r.Type === "AWS::IAM::Policy");
    for (const name of senders) {
      const [, rolePolicy]: any = policies.find(([id]) => id.startsWith(name))!; const statements = rolePolicy.Properties.PolicyDocument.Statement;
      if (["magicLinkVerify", "mailVerification"].includes(name)) {
        expect(statements.some((s: any) => s.Effect === "Deny" && s.NotResource)).toBe(true);
        expect(statements.some((s: any) => s.Effect === "Deny" && s.Condition?.DateGreaterThanEquals?.["aws:CurrentTime"] === expiry)).toBe(true);
        expect(statements.some((s: any) => s.Effect === "Deny" && s.Condition?.["ForAnyValue:StringNotEquals"]?.["ses:Recipients"]?.[0] === "jake@getgim.com")).toBe(true);
        expect(statements.some((s: any) => s.Effect === "Allow" && s.Condition?.DateLessThan?.["aws:CurrentTime"] === expiry)).toBe(true);
        const scoped = statements.find((s: any) => s.Effect === "Allow" && s.Condition?.DateLessThan?.["aws:CurrentTime"] === expiry);
        expect(scoped.Condition.StringEquals["ses:FromAddress"]).toEqual(name === "mailVerification" ? ["noreply@protectmyhoa.com", "insurance@protectmyhoa.com"] : ["noreply@protectmyhoa.com"]);
        const otherSending = statements.find((s: any) => s.Effect === "Deny" && Array.isArray(s.Action) && s.Action.includes("ses:SendRawEmail"));
        expect(otherSending.Action).toContain("ses:SendBulkEmail"); expect(otherSending.Action).toContain("ses:SendCustomVerificationEmail");
      } else expect(statements.some((s: any) => s.Effect === "Deny" && s.Action === "ses:Send*" && !s.Condition)).toBe(true);
    }
  });
  it("switches only main when SES is explicitly selected and keeps Resend recovery assets", () => {
    vi.stubEnv("HOA_TRANSACTIONAL_MAIL_PROVIDER", "ses"); vi.stubEnv("HOA_SES_DAILY_LIMIT", "1000"); vi.stubEnv("HOA_SES_MONTHLY_LIMIT", "30000");
    const { existing, backend } = infra();
    for (const name of senders) {
      const vars = mailFunction(existing, name).Properties.Environment.Variables; expect(vars.HOA_TRANSACTIONAL_MAIL_PROVIDER).toBe("ses");
      expect(vars.HOA_SES_DAILY_LIMIT).toBe("1000"); expect(vars.HOA_SES_MONTHLY_LIMIT).toBe("30000"); expect(vars.HOA_RESEND_SECRET_ARN).toContain("hoa/resend/sending-");
    }
    expect(mailFunction(existing, "mailFeedback").Properties.Environment.Variables.HOA_TRANSACTIONAL_MAIL_PROVIDER).toBe("resend");
    expect(statements(existing).filter((s: any) => s.Effect === "Deny" && s.NotResource)).toHaveLength(7);
    expect(statements(existing).filter((s: any) => s.Effect === "Deny" && Array.isArray(s.Action) && s.Action.includes("ses:SendRawEmail"))).toHaveLength(7);
    expect(backend.addOutput).toHaveBeenCalledWith({ custom: { transactionalMail: expect.objectContaining({ provider: "ses", dailyLimit: 1000, monthlyLimit: 30000 }) } });
  });
  it.each(["staging", "preview"])("refuses an unapproved SES %s selection", branch => {
    vi.stubEnv("HOA_TRANSACTIONAL_MAIL_PROVIDER", "ses"); if (branch === "staging") config.businessBranch = "staging"; else config.migrationPreview = true;
    expect(() => infra()).toThrow("only for the HOA main backend");
  });
  it.each(["0", "-1", "100x", "50001", "1.5"])("rejects malformed or excessive SES daily limit %s", value => {
    vi.stubEnv("HOA_SES_DAILY_LIMIT", value); expect(() => infra()).toThrow("application limit");
  });
});
