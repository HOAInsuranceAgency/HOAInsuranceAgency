// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { Function, Code, Runtime } from "aws-cdk-lib/aws-lambda";
import { Topic } from "aws-cdk-lib/aws-sns";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";

const config = vi.hoisted(() => ({ migrationDestination: true, migrationPreview: false, businessBranch: "main" }));
vi.mock("../../amplify/migration-config", () => config);
import { installTransactionalMail } from "../../amplify/transactional-mail";
const identity = "arn:aws:ses:us-east-1:917680434255:identity/protectmyhoa.com";
const senders = ["magicLinkVerify", "teamAdmin", "sendInvoice", "marketingReportWorker", "commissionPayrollWorker", "stripeWebhook", "mailVerification", "mailRecovery"];
function infra() {
  const app = new App(); const stack = new Stack(app, "ExistingMail", { env: { account: "917680434255", region: "us-east-1" } });
  const sesStack = new Stack(app, "NewSesMail", { env: { account: "917680434255", region: "us-east-1" } });
  const shared = new Map<string, Stack>();
  const backend: any = { createStack: (name: string) => { const s = new Stack(app, name, { env: { account: "917680434255", region: "us-east-1" } }); shared.set(name, s); return s; }, addOutput: vi.fn() };
  for (const name of [...senders,"voidInvoice","crmAccess","pfElection", ...(config.migrationPreview ? [] : ["sesMailFeedback"])]) {
    const fn = new Function(name === "sesMailFeedback" ? sesStack : stack, name, { runtime: Runtime.NODEJS_22_X, handler: "index.handler", code: Code.fromInline("exports.handler=async()=>({});") });
    if (senders.includes(name)) fn.addToRolePolicy(new PolicyStatement({ actions: ["ses:SendEmail", "ses:SendRawEmail"], resources: ["*"] }));
    backend[name] = { resources: { lambda: fn }, addEnvironment: (key: string, value: string) => fn.addEnvironment(key, value) };
  }
  installTransactionalMail(backend, new Topic(stack, "ExistingAlertTopic"));
  return { backend, existing: Template.fromStack(stack).toJSON(), ses: Template.fromStack(sesStack).toJSON(), shared: shared.has("TransactionalMail") ? Template.fromStack(shared.get("TransactionalMail")!).toJSON() : undefined, retirement: shared.has("InvoiceSendRetirementPermissions") ? Template.fromStack(shared.get("InvoiceSendRetirementPermissions")!).toJSON() : undefined, permissions: shared.has("TransactionalMailSendPermissions") ? Template.fromStack(shared.get("TransactionalMailSendPermissions")!).toJSON() : undefined };
}
function resources(template: any): any[] { return Object.values(template.Resources ?? {}); }
function statements(template: any): any[] { return resources(template).filter(r => ["AWS::IAM::Policy", "AWS::IAM::ManagedPolicy"].includes(r.Type)).flatMap(r => r.Properties.PolicyDocument.Statement); }
function mailFunction(template: any, name: string): any { return Object.entries(template.Resources ?? {}).find(([id, r]: [string, any]) => r.Type === "AWS::Lambda::Function" && id.startsWith(name))?.[1]; }
function senderPolicy(template: any, name: string): any[] { return (Object.entries(template.Resources).find(([id, r]: [string, any]) => r.Type === "AWS::IAM::Policy" && id.startsWith(name))![1] as any).Properties.PolicyDocument.Statement; }
function attachedSendStatements(existing: any, permissions: any, name: string): any[] {
  const roleId = mailFunction(existing, name).Properties.Role["Fn::GetAtt"][0];
  const imports = (existing.Resources[roleId].Properties.ManagedPolicyArns ?? [])
    .flatMap((ref: any) => ref["Fn::ImportValue"] ? [ref["Fn::ImportValue"]] : []);
  const policies = Object.values(permissions.Outputs ?? {}).filter((output: any) => imports.includes(output.Export?.Name))
    .map((output: any) => permissions.Resources[output.Value.Ref]);
  expect(policies).toHaveLength(1);
  return policies.flatMap((policy: any) => policy.Properties.PolicyDocument.Statement);
}
beforeEach(() => {
  config.migrationDestination = true; config.migrationPreview = false; config.businessBranch = "main";
  vi.stubEnv("HOA_TRANSACTIONAL_MAIL_PROVIDER", "ses"); vi.stubEnv("HOA_SES_DAILY_LIMIT", "1000"); vi.stubEnv("HOA_SES_MONTHLY_LIMIT", "30000");
  vi.stubEnv("HOA_TRANSACTIONAL_MAIL_RELEASE", "true"); vi.stubEnv("HOA_TRANSACTIONAL_MAIL_RECOVERY_ENABLED", "false"); vi.stubEnv("HOA_SES_VERIFICATION_EXPIRES_AT", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("SES-only transactional mail infrastructure", () => {
  it.each(["main", "staging"])("uses only SES for %s without public callbacks or credential grants", branch => {
    config.businessBranch = branch; const { existing, ses, backend } = infra();
    for (const name of senders) {
      const vars = mailFunction(existing, name).Properties.Environment.Variables;
      expect(vars.HOA_TRANSACTIONAL_MAIL_PROVIDER).toBe("ses"); expect(vars.HOA_SES_IDENTITY_ARN).toBe(identity); expect(vars.HOA_SES_CONFIGURATION_SET).toBe(`hoa-transactional-${branch}`);
      expect(vars.HOA_SES_DAILY_LIMIT).toBe("1000"); expect(vars.HOA_SES_MONTHLY_LIMIT).toBe("30000");
      expect(Object.keys(vars).some(k => k.includes("RESEND") || k.includes("CANARY"))).toBe(false);
      expect(vars.HOA_SES_VERIFICATION_EXPIRES_AT).toBe(name === "mailVerification" ? "" : undefined);
    }
    expect(mailFunction(existing, "mailRecovery").Properties.Environment.Variables.HOA_TRANSACTIONAL_MAIL_RECOVERY_ENABLED).toBe("false");
    expect(statements(existing).some(s => (Array.isArray(s.Action) ? s.Action : [s.Action]).includes("secretsmanager:GetSecretValue"))).toBe(false);
    expect([...resources(existing), ...resources(ses)].filter(r => r.Type === "AWS::Lambda::Url")).toHaveLength(0);
    expect(backend.mailFeedback).toBeUndefined(); expect(JSON.stringify(existing)).not.toContain("hoa/resend/");
    expect(backend.addOutput).toHaveBeenCalledWith({ custom: { transactionalMail: { provider: "ses", tableName: "HOA-TransactionalMail", outboxBucket: "hoa-transactional-mail-917680434255-us-east-1", dailyLimit: 1000, monthlyLimit: 30000 } } });
  });
  it("defaults to SES and rejects retired or unknown provider selection", () => {
    vi.stubEnv("HOA_TRANSACTIONAL_MAIL_PROVIDER", undefined); expect(() => infra()).not.toThrow();
    for (const provider of ["resend", "unknown", ""]) { vi.stubEnv("HOA_TRANSACTIONAL_MAIL_PROVIDER", provider); expect(() => infra()).toThrow("requires its approved SES backend"); }
  });
  it.each(["main", "staging"])("fences every %s role despite its legacy wildcard grant", branch => {
    config.businessBranch = branch; const { existing, permissions } = infra();
    const allowedFrom = branch === "main" ? ["noreply@protectmyhoa.com", "insurance@protectmyhoa.com"] : ["noreply@protectmyhoa.com", "jake+testing@protectmyhoa.com"];
    for (const name of senders) {
      expect(senderPolicy(existing, name).some(s => s.Effect === "Allow" && s.Resource === "*")).toBe(true);
      const functionRole = mailFunction(existing, name).Properties.Role["Fn::GetAtt"][0];
      expect(JSON.stringify(existing.Resources[functionRole].Properties.ManagedPolicyArns)).toContain("TransactionalMailSendPermissions");
      const ss = attachedSendStatements(existing, permissions, name);
      const allowedRecipients = name === "magicLinkVerify" ? ["jake@getgim.com", "ethanroden@getgim.com", "brian@protectmyhoa.com"] : ["jake@getgim.com"];
      const boundary = ss.find(s => s.Effect === "Deny" && s.NotResource); expect(boundary.NotResource).toHaveLength(2); expect(JSON.stringify(boundary)).toContain("identity/protectmyhoa.com"); expect(JSON.stringify(boundary)).toContain(`configuration-set/hoa-transactional-${branch}`);
      expect(ss.some(s => s.Effect === "Deny" && s.Condition?.StringNotEquals?.["ses:FromAddress"]?.join() === allowedFrom.join())).toBe(true);
      const alternate = ss.find(s => s.Effect === "Deny" && Array.isArray(s.Action) && s.Action.includes("ses:SendRawEmail"));
      expect(alternate.Action).toEqual(["ses:SendRawEmail", "ses:SendBulkEmail", "ses:SendTemplatedEmail", "ses:SendBulkTemplatedEmail", "ses:SendCustomVerificationEmail", "ses:SendBounce"]);
      const scoped = ss.find(s => s.Effect === "Allow" && s.Condition?.StringEquals?.["ses:FromAddress"]);
      expect(scoped.Condition).toEqual({ StringEquals: { "ses:FromAddress": allowedFrom }, ...(branch === "staging" ? { "ForAllValues:StringEquals": { "ses:Recipients": allowedRecipients } } : {}) });
      if (branch === "staging") {
        expect(ss.some(s => s.Effect === "Deny" && s.Condition?.["ForAnyValue:StringNotEquals"]?.["ses:Recipients"]?.join() === allowedRecipients.join())).toBe(true);
        expect(ss.some(s => s.Effect === "Deny" && s.Condition?.Null?.["ses:Recipients"] === "true")).toBe(true);
      } else expect(JSON.stringify(ss)).not.toContain("ses:Recipients");
      expect(JSON.stringify(ss)).not.toContain("aws:CurrentTime");
    }
  });
  it("grants the extra staging login recipients to authentication only", () => {
    config.businessBranch = "staging";
    const { existing, permissions } = infra();
    expect(resources(permissions).filter(r => r.Type === "AWS::IAM::ManagedPolicy")).toHaveLength(2);
    for (const name of senders) {
      const serialized = JSON.stringify(attachedSendStatements(existing, permissions, name));
      for (const recipient of ["ethanroden@getgim.com", "brian@protectmyhoa.com"]) {
        expect(serialized.includes(recipient)).toBe(name === "magicLinkVerify");
      }
    }
  });
  it("uses one independent stateless managed policy instead of repeating the boundary in sender inline policies", () => {
    const { existing, permissions } = infra();
    expect(resources(permissions).filter(r => r.Type === "AWS::IAM::ManagedPolicy")).toHaveLength(1);
    expect(resources(permissions).every(r => ["AWS::IAM::ManagedPolicy", "AWS::CDK::Metadata"].includes(r.Type))).toBe(true);
    const policy = resources(permissions).find(r => r.Type === "AWS::IAM::ManagedPolicy" && !r.Properties.Roles);
    expect(policy.Properties.Roles).toBeUndefined();
    expect(JSON.stringify(policy)).not.toContain("Fn::GetAtt"); expect(JSON.stringify(policy)).not.toContain("Ref");
    expect(JSON.stringify(policy)).not.toContain("FeedbackTopic"); expect(JSON.stringify(policy)).not.toContain("ExistingAlertTopic");
    expect(statements(existing).some(s => s.NotResource || s.Condition?.StringNotEquals?.["ses:FromAddress"])).toBe(false);
  });
  it.each(["main", "staging"])("binds %s private feedback to its configuration set, account and ledger prefix", branch => {
    config.businessBranch = branch; const { ses } = infra(); const rs = resources(ses);
    expect(ses.Resources.FeedbackTopic7463F779.Properties.TopicName).toBe(`hoa-transactional-${branch}-feedback`);
    expect(ses.Resources.ConfigurationSet3DD38186.Properties.Name).toBe(`hoa-transactional-${branch}`);
    const policy = rs.find(r => r.Type === "AWS::SNS::TopicPolicy").Properties.PolicyDocument.Statement;
    expect(policy).toHaveLength(1); expect(policy[0].Principal).toEqual({ Service: "ses.amazonaws.com" }); expect(policy[0].Condition.StringEquals["AWS:SourceAccount"]).toBe("917680434255");
    expect(policy[0].Condition.StringEquals["AWS:SourceArn"]).toEqual({ "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":ses:us-east-1:917680434255:configuration-set/", { Ref: "ConfigurationSet3DD38186" }]] });
    const invocation = rs.find(r => r.Type === "AWS::Lambda::Permission").Properties; expect(invocation.Principal).toBe("sns.amazonaws.com"); expect(invocation.SourceAccount).toBe("917680434255"); expect(invocation.SourceArn).toEqual({ Ref: "FeedbackTopic7463F779" });
    const ss = statements(ses); expect(ss.some(s => s.Effect === "Deny" && s.Action.includes("secretsmanager:GetSecretValue") && s.Action.includes("ses:Send*"))).toBe(true);
    expect(ss.find(s => s.Effect === "Allow" && s.Action.includes("dynamodb:UpdateItem")).Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"]).toEqual(["EVENT#ses#*", "RECEIPT#ses#*", "SUPPRESSION#*", `OP#hoa/${branch}/*`]);
    expect(mailFunction(ses, "sesMailFeedback").Properties.Environment.Variables.HOA_SES_CONFIGURATION_SET).toBe(`hoa-transactional-${branch}`);
    expect(rs.filter(r => r.Type === "AWS::Lambda::EventSourceMapping")).toHaveLength(0);
  });
  it("retains failure queues, async routing, feedback alarms and the existing shared alarm logical ID", () => {
    const { ses, shared } = infra(); const rs = resources(ses); const queue = rs.find(r => r.Type === "AWS::SQS::Queue");
    expect(queue.Properties.SqsManagedSseEnabled).toBe(true); expect(queue.Properties.MessageRetentionPeriod).toBe(1209600); expect(queue.DeletionPolicy).toBe("Retain"); expect(queue.UpdateReplacePolicy).toBe("Retain");
    const async = rs.find(r => r.Type === "AWS::Lambda::EventInvokeConfig").Properties; expect(async.MaximumRetryAttempts).toBe(2); expect(async.MaximumEventAgeInSeconds).toBe(21600); expect(async.DestinationConfig.OnFailure.Destination).toBeDefined();
    expect(rs.find(r => r.Type === "AWS::SNS::Subscription").Properties.RedrivePolicy.deadLetterTargetArn).toBeDefined(); expect(rs.filter(r => r.Type === "AWS::CloudWatch::Alarm")).toHaveLength(3);
    expect(shared!.Resources.NeedsReviewF3500CEA.Type).toBe("AWS::CloudWatch::Alarm"); expect(shared!.Resources.NeedsReviewF3500CEA.Properties.MetricName).toBe("DeliveryNeedsReview");
  });
  it("places the independent manual verification expiry only on its function", () => {
    vi.stubEnv("HOA_SES_VERIFICATION_EXPIRES_AT", "2026-11-04T06:00:00.000Z"); const { existing } = infra();
    for (const name of senders) expect(mailFunction(existing, name).Properties.Environment.Variables.HOA_SES_VERIFICATION_EXPIRES_AT).toBe(name === "mailVerification" ? "2026-11-04T06:00:00.000Z" : undefined);
  });
  it("denies every send in previews without requiring feedback resources", () => {
    config.migrationPreview = true; const { existing, ses } = infra();
    expect(statements(existing).filter(s => s.Effect === "Deny" && s.Action === "ses:Send*" && s.Resource === "*")).toHaveLength(senders.length); expect(resources(ses)).toHaveLength(0);
  });
  it.each(["0", "-1", "100x", "50001", "1.5"])("rejects invalid SES daily limit %s", value => {
    vi.stubEnv("HOA_SES_DAILY_LIMIT", value); expect(() => infra()).toThrow("application limit");
  });
});

it.each(['main','staging'])('grants %s Void/edit/PF only invoice mail OP retirement in an independent managed policy',branch=>{
 config.businessBranch=branch;
 const {retirement,existing}=infra();
 const policies=resources(retirement).filter(row=>row.Type==='AWS::IAM::ManagedPolicy');expect(policies).toHaveLength(1);
 expect(policies[0].Properties.Roles).toHaveLength(3);
 expect(policies[0].Properties.PolicyDocument.Statement).toEqual([{
  Action:['dynamodb:GetItem','dynamodb:UpdateItem'],Effect:'Allow',Resource:'arn:aws:dynamodb:us-east-1:917680434255:table/HOA-TransactionalMail',
  Condition:{'ForAllValues:StringLike':{'dynamodb:LeadingKeys':[`OP#hoa/${branch}/invoice/*`]}},
 }]);
 for(const name of ['voidInvoice','crmAccess','pfElection']){
  expect(mailFunction(existing,name).Properties.Environment.Variables.HOA_TRANSACTIONAL_MAIL_TABLE).toBe('HOA-TransactionalMail');
  expect(JSON.stringify(policies[0].Properties.Roles)).toContain(name);
 }
 expect(JSON.stringify(retirement)).not.toContain('ses:');expect(JSON.stringify(retirement)).not.toContain('s3:');expect(JSON.stringify(retirement)).not.toContain('TransactionalMailSendPermissions');
});
