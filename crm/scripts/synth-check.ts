/**
 * Synthesise the backend locally, the way Amplify's pipeline does.
 *
 *   npm run synth:check
 *
 * ## Why this exists
 *
 * W7 shipped this line in `amplify/backend.ts`:
 *
 *   (table.node.defaultChild as CfnTable).streamSpecification = { … }
 *
 * `npm run typecheck` passed, every test passed, and the staging build failed
 * with `Cannot set properties of undefined (setting 'streamSpecification')` —
 * because an Amplify data table is a `Custom::AmplifyDynamoDBTable` custom
 * resource with no CfnTable default child, and the `as CfnTable` cast asserted
 * away the only evidence a compiler had. Nine commits sat unbuilt behind it.
 *
 * The gap is structural, not a lapse: `tsc` checks types and CDK constructs
 * fail at *construction*, which only happens during synth. So the check is a
 * synth. It needs no AWS credentials and touches nothing — it builds the
 * CloudFormation assembly in a temp directory and throws it away.
 *
 * ## What it does and does not catch
 *
 * Catches: anything that throws while constructing the backend, plus anything
 * CloudFormation-invalid enough to fail assembly — a bad ARN shape, a
 * dangling reference, a construct given a property it does not have.
 *
 * Does not catch: whether the deploy succeeds. A stack can synthesise
 * perfectly and still be rejected — a resource limit, an IAM policy the
 * account will not accept, a DynamoDB table property that cannot be changed on
 * an existing table. Those need a real deploy. This is the cheap gate that
 * removes the class of failure that cost this workstream a week.
 *
 * ## Also does not catch: module resolution
 *
 * This runs under `tsx`, which transpiles any TypeScript it is pointed at.
 * `ampx pipeline-deploy` loads `amplify/backend.ts` with a loader scoped to
 * `amplify/`, so an import reaching OUTSIDE that directory resolves to a
 * module with no exports and the deploy fails with "does not provide an
 * export named 'X'". Deployment 59 died that way on a
 * `../../shared/agency` import that `tsc`, the tests and this script all
 * passed. Lambda handlers are exempt — esbuild bundles those, which is why
 * `renewal-tasks/handler.ts` imports `src/lib/pagination` and always has.
 *
 * So: keep `backend.ts` and everything it imports at synth time inside
 * `amplify/`. If a value has to be shared with the app, read it in the
 * handler rather than passing it down from here. `assertNoEscapingImports`
 * below enforces that, because a note in a comment would not have.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { CfnResource, Stack, type App } from "aws-cdk-lib";
import type { CfnFunction, CfnEventInvokeConfig } from "aws-cdk-lib/aws-lambda";
import type { CfnSchedule } from "aws-cdk-lib/aws-scheduler";

const AMPLIFY = resolve(process.cwd(), "amplify");

/**
 * Walk the synth-time import graph from `backend.ts` and reject any relative
 * import that leaves `amplify/`.
 *
 * Handlers are absent from this graph for free: `defineFunction` names its
 * entry as a path *string* (`entry: "./handler.ts"`), so nothing imports a
 * handler at synth time and the walk never reaches one. That is the
 * distinction that matters — handlers are esbuild-bundled at deploy and may
 * import from `src/` and `shared/`, as `renewal-tasks` does.
 */
function assertNoEscapingImports(): void {
  const seen = new Set<string>();
  const bad: string[] = [];

  const resolveFile = (spec: string, from: string): string | null => {
    const base = resolve(dirname(from), spec);
    for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
      if (existsSync(c) && !c.endsWith("/")) return c;
    }
    return null;
  };

  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    // Bare specifiers are packages — node_modules is not the concern here.
    for (const m of src.matchAll(/^\s*import\s[^'"]*?['"](\.[^'"]+)['"]/gm)) {
      const target = resolveFile(m[1], file);
      if (!target) continue;
      if (relative(AMPLIFY, target).startsWith("..")) {
        bad.push(`${relative(process.cwd(), file)} → ${m[1]}`);
        continue;
      }
      walk(target);
    }
  };

  walk(join(AMPLIFY, "backend.ts"));

  if (bad.length) {
    console.error(
      "✘ Synth-time import escapes amplify/ — this deploys fine locally and " +
        "fails in the pipeline with \"does not provide an export named …\":\n" +
        bad.map((b) => `    ${b}`).join("\n") +
        "\n\n  Read the value in the Lambda handler instead; handlers are " +
        "bundled by esbuild and have no such limit."
    );
    process.exit(1);
  }
}

assertNoEscapingImports();

// `defineBackend` reads these three from CDK context. The pipeline supplies
// them; a local run has to. The values only name the assembly — nothing is
// contacted and nothing is deployed, so they need to be well-formed rather
// than real. Use the pipeline identity when available so generated template
// sizes match deployment; longer names consume more of the template limit.
const outdir = mkdtempSync(join(tmpdir(), "amplify-synth-"));
process.env.CDK_CONTEXT_JSON = JSON.stringify({
  "amplify-backend-namespace": process.env.AWS_APP_ID ?? "synth-check",
  "amplify-backend-name": process.env.AWS_BRANCH ?? "local",
  "amplify-backend-type": "branch",
  // Toolkit.fromAssemblyBuilder supplies these defaults during pipeline-deploy.
  // Include its resource metadata so this byte-size gate measures the same output.
  "aws:cdk:enable-path-metadata": true,
  "aws:cdk:enable-asset-metadata": true,
  "aws:cdk:version-reporting": true,
  "aws:cdk:bundling-stacks": ["**"],
});
process.env.CDK_OUTDIR = outdir;

try {
  // Imported for its side effects first: this is where construct constructors
  // run, and where the W7 bug threw.
  const { backend } = await import("../amplify/backend");

  // Then the assembly itself, which is the half an import alone would miss.
  const app = backend.stack.node.root as App;
  const assembly = app.synth();
  // Retirement must remove both deployment registration and scheduled delivery.
  // Historical tables remain available, but no old daily mail job is deployed.
  const retiredJobs = ["taskDigest", "opsRollup", "licenseAlerts", "communicationReports", "renewalTasks"];
  if (retiredJobs.some(name => name in backend)) throw new Error("Retired task and daily staff email jobs must not be registered");
  const retiredPaths = retiredJobs.map(name => name.toLowerCase());
  for (const node of app.node.findAll()) {
    const type = (node as { cfnResourceType?: string }).cfnResourceType;
    if (!["AWS::Lambda::Function", "AWS::Events::Rule", "AWS::Scheduler::Schedule"].includes(type ?? "")) continue;
    const path = node.node.path.toLowerCase().replace(/[^a-z]/g, "");
    if (retiredPaths.some(name => path.includes(name))) throw new Error(`Retired job still has deployed infrastructure: ${node.node.path}`);
  }
  const defaultSweepEnv = Stack.of(backend.pfDefaultSweep.resources.lambda).resolve((backend.pfDefaultSweep.resources.lambda.node.defaultChild as CfnFunction).environment);
  if (defaultSweepEnv.variables.ACCOUNTING_MAILBOX || defaultSweepEnv.variables.AGENCY_MAILBOX) throw new Error("Default detection must not configure daily staff email recipients");
  for (const node of backend.pfDefaultSweep.resources.lambda.role!.node.findAll()) {
    const resource = node as unknown as { cfnResourceType?: string; policyDocument?: unknown };
    if (resource.cfnResourceType === "AWS::IAM::Policy" && JSON.stringify(Stack.of(node).resolve(resource.policyDocument)).includes("ses:Send")) throw new Error("Default detection must not retain staff-email send permissions");
  }
  for (const fn of [backend.communicationWorker, backend.leadReply, backend.portalSweep, backend.marketingReportWorker]) {
    const resource = fn.resources.lambda.node.defaultChild as CfnFunction;
    if (Stack.of(resource).resolve(resource.reservedConcurrentExecutions) !== 1) throw new Error(`${resource.node.path} must retain reserved concurrency 1`);
  }
  const carrierEnv = Stack.of(backend.honeycombWorker.resources.lambda).resolve((backend.honeycombWorker.resources.lambda.node.defaultChild as CfnFunction).environment);
  const intakeEnv = Stack.of(backend.leadIntake.resources.lambda).resolve((backend.leadIntake.resources.lambda.node.defaultChild as CfnFunction).environment);
  const staging = process.env.AWS_BRANCH === "staging";
  if (carrierEnv.variables.HONEYCOMB_ENABLED !== String(staging) || intakeEnv.variables.HONEYCOMB_ENABLED !== String(staging)) throw new Error("Honeycomb must only run on staging");
  if (!staging && JSON.stringify(carrierEnv).includes("HONEYCOMB_API_SECRET_KEY")) throw new Error("Non-staging deployment must not resolve Honeycomb secrets");
  for (const fn of [backend.honeycombSubmissions, backend.honeycombSubmissionWorker]) {
    const env = Stack.of(fn.resources.lambda).resolve((fn.resources.lambda.node.defaultChild as CfnFunction).environment);
    if (env.variables.HONEYCOMB_ENABLED !== String(staging)) throw new Error("Submissions must only run on staging");
    if (!staging && JSON.stringify(env).includes("HONEYCOMB_API_SECRET_KEY")) throw new Error("Non-staging submissions must not resolve secrets");
  }
  const { checkAccountAccess } = await import("./check-account-access");
  checkAccountAccess(backend, outdir);
  const { checkOwnerProfitability } = await import("./check-owner-profitability");
  checkOwnerProfitability(backend);
  // Dashboard interest must use a backfilled time index without dropping the
  // loan relation or account-access indexes already on the payment table.
  const paymentTable = app.node.findAll().find((node): node is CfnResource =>
    node instanceof CfnResource && node.cfnResourceType === "Custom::AmplifyDynamoDBTable" &&
    node.node.path.endsWith("/PfLoanPayment/PfLoanPaymentTable/Default/Default"));
  if (!paymentTable) throw new Error("Missing dashboard payment table");
  const paymentTemplate = Stack.of(paymentTable).resolve(paymentTable._toCloudFormation());
  const paymentProperties = Object.values(paymentTemplate.Resources as Record<string, { Properties: { globalSecondaryIndexes: { indexName: string; keySchema: { attributeName: string; keyType: string }[]; projection: { projectionType: string; nonKeyAttributes?: string[] } }[] } }>)[0].Properties;
  const paymentIndexes = paymentProperties.globalSecondaryIndexes;
  const receiptIndex = paymentIndexes.find(index => index.indexName === "dashboardPaymentsByDate");
  if (!receiptIndex || JSON.stringify(receiptIndex.keySchema) !== JSON.stringify([{ attributeName: "__typename", keyType: "HASH" }, { attributeName: "postedAt", keyType: "RANGE" }]) || receiptIndex.projection.projectionType !== "INCLUDE" || !["accountId", "interest"].every(field => receiptIndex.projection.nonKeyAttributes?.includes(field))) throw new Error("Dashboard receipts must have a projected date index");
  if (!paymentIndexes.some(index => index.indexName === "crmBy_loanId") || !paymentIndexes.some(index => index.indexName !== "crmBy_loanId" && index.keySchema.some(key => key.attributeName === "loanId"))) throw new Error("Dashboard index must preserve existing payment relation and access indexes");
  const reportEnv = Stack.of(backend.communications.resources.lambda).resolve((backend.communications.resources.lambda.node.defaultChild as CfnFunction).environment);
  if (reportEnv.variables.DASHBOARD_PAYMENT_INDEX !== "dashboardPaymentsByDate" || !reportEnv.variables.DASHBOARD_PAYMENT_TABLE || !reportEnv.variables.DASHBOARD_POLICY_TABLE) throw new Error("Dashboard reads must use the configured payment index and policy table");
  for (const [model, expectedIndex, hash, range] of [["Quote", "dashboardQuotesByStatus", "status", ""], ["Policy", "dashboardPoliciesByBindDate", "__typename", "datePolicyBound"]]) {
    const table = app.node.findAll().find((node): node is CfnResource => node instanceof CfnResource && node.cfnResourceType === "Custom::AmplifyDynamoDBTable" && node.node.path.endsWith(`/${model}/${model}Table/Default/Default`));
    if (!table) throw new Error(`Missing dashboard ${model} table`);
    const template = Stack.of(table).resolve(table._toCloudFormation());
    const props = Object.values(template.Resources as Record<string, { Properties: typeof paymentProperties }>)[0].Properties;
    const index = props.globalSecondaryIndexes.find(item => item.indexName === expectedIndex);
    if (!index || index.keySchema[0]?.attributeName !== hash || (range && index.keySchema[1]?.attributeName !== range) || !index.projection.nonKeyAttributes?.includes("accountId")) throw new Error(`Missing scoped ${model} dashboard index`);
    if (!props.globalSecondaryIndexes.some(item => item.keySchema[0]?.attributeName === "accountId" && item.projection.projectionType === "ALL")) throw new Error(`Dashboard must preserve ${model} account relation`);
  }
  if (!reportEnv.variables.DASHBOARD_QUOTE_ACCOUNT_INDEX || !reportEnv.variables.DASHBOARD_INVOICE_LINE_INDEX) throw new Error("Batched dashboard joins need configured relation indexes");
  // Inspect what will deploy, scoped to the communications execution role.
  // CDK can emit inline Role policies, AWS::IAM::Policy, or the newer
  // AWS::IAM::RolePolicy. Inspecting only CfnPolicy constructs misses the
  // latter even when its Deny is present in the synthesized template.
  type IamStatement = { Effect?: string; Action?: string | string[]; Resource?: unknown | unknown[]; Condition?: { Bool?: Record<string, unknown> } };
  type IamDocument = { Statement?: IamStatement[] };
  type IamResource = { Type: string; Properties?: {
    Policies?: { PolicyDocument?: IamDocument }[];
    PolicyDocument?: IamDocument; Roles?: unknown[]; RoleName?: unknown;
  } };
  const reportRole = backend.communications.resources.lambda.role!.node.defaultChild as CfnResource;
  const reportRoleStack = Stack.of(reportRole);
  const reportRoleId = reportRoleStack.getLogicalId(reportRole);
  const reportTemplate = JSON.parse(readFileSync(join(outdir, reportRoleStack.templateFile), "utf8")) as { Resources: Record<string, IamResource> };
  const reportRoleResource = reportTemplate.Resources[reportRoleId];
  if (reportRoleResource?.Type !== "AWS::IAM::Role") throw new Error("Missing synthesized communications execution role");
  const referencesReportRole = (value: unknown) => JSON.stringify(value) === JSON.stringify({ Ref: reportRoleId });
  const reportDocuments = [
    ...(reportRoleResource.Properties?.Policies ?? []).flatMap(policy => policy.PolicyDocument ? [policy.PolicyDocument] : []),
    ...Object.values(reportTemplate.Resources).flatMap(resource => {
      const props = resource.Properties;
      const attached = resource.Type === "AWS::IAM::RolePolicy"
        ? referencesReportRole(props?.RoleName)
        : ["AWS::IAM::Policy", "AWS::IAM::ManagedPolicy"].includes(resource.Type) && props?.Roles?.some(referencesReportRole);
      return attached && props?.PolicyDocument ? [props.PolicyDocument] : [];
    }),
  ];
  for (const model of ["Policy", "Invoice"]) {
    const table = app.node.findAll().find((node): node is CfnResource => node instanceof CfnResource && node.cfnResourceType === "Custom::AmplifyDynamoDBTable" && node.node.path.endsWith(`/${model}/${model}Table/Default/Default`));
    if (!table) throw new Error(`Missing ${model} table for lead deletion`);
    const template = Stack.of(table).resolve(table._toCloudFormation());
    const props = Object.values(template.Resources as Record<string, { Properties: typeof paymentProperties }>)[0].Properties;
    const indexName = reportEnv.variables[`LEAD_DELETION_${model.toUpperCase()}_INDEX`];
    const index = props.globalSecondaryIndexes.find(item => item.indexName === indexName);
    if (!index || index.keySchema.length !== 1 || index.keySchema[0].attributeName !== "accountId" || index.keySchema[0].keyType !== "HASH" || index.projection.projectionType !== "ALL") throw new Error(`Lead deletion must use the existing ${model} account relation index`);
    const expectedTable = reportRoleStack.resolve(`${model}-${backend.data.resources.graphqlApi.apiId}-NONE`);
    if (JSON.stringify(reportEnv.variables[`LEAD_DELETION_${model.toUpperCase()}_TABLE`]) !== JSON.stringify(expectedTable)) throw new Error(`Lead deletion must use the configured ${model} table`);
    const queryResources = reportDocuments.flatMap(document => document.Statement ?? [])
      .filter(statement => statement.Effect === "Allow" && [statement.Action].flat().includes("dynamodb:Query"))
      .flatMap(statement => [statement.Resource].flat()).map(resource => JSON.stringify(resource));
    if (!queryResources.some(resource => resource?.includes(`table/${model}-`) && resource.includes(`/index/${indexName}`) && !resource.includes("*"))) throw new Error(`Lead deletion needs an exact Query grant on the ${model} account relation index`);
  }
  const reportDenyResources = reportDocuments.flatMap(document => document.Statement ?? []).filter(statement =>
    statement.Effect === "Deny" && [statement.Action].flat().includes("dynamodb:PartiQLSelect") &&
    [statement.Condition?.Bool?.["dynamodb:FullTableScan"]].flat().some(value => String(value) === "true")
  ).flatMap(statement => [statement.Resource].flat()).map(resource => JSON.stringify(resource));
  for (const [model, index] of [["Quote", reportEnv.variables.DASHBOARD_QUOTE_ACCOUNT_INDEX], ["InvoiceLine", reportEnv.variables.DASHBOARD_INVOICE_LINE_INDEX]]) {
    for (const indexed of [false, true]) {
      if (!reportDenyResources.some(resource => resource?.includes(`table/${model}-`) && (indexed ? resource.includes(`/index/${index}`) : !resource.includes("/index/")))) {
        throw new Error(`Indexed report joins must deny PartiQL full scans on the communications role: ${model}${indexed ? `/${index}` : ""}`);
      }
    }
  }
  const marketingWorker = backend.marketingReportWorker.resources.lambda;
  const marketingEnv = Stack.of(marketingWorker).resolve((marketingWorker.node.defaultChild as CfnFunction).environment);
  if (Stack.of(marketingWorker) === Stack.of(backend.marketingReportApi.resources.lambda)) throw new Error("Marketing worker infrastructure must stay outside the crowded data stack");
  const apiEnv = Stack.of(backend.marketingReportApi.resources.lambda).resolve((backend.marketingReportApi.resources.lambda.node.defaultChild as CfnFunction).environment);
  const workerName = (marketingWorker.node.defaultChild as CfnFunction).functionName;
  if (typeof workerName !== "string" || workerName.length > 64 || apiEnv.variables.MARKETING_REPORT_WORKER !== workerName) throw new Error("Marketing API must invoke the exact named worker without a cross-stack reference");
  const marketingSchedule = Stack.of(marketingWorker).node.findChild("WeeklyMarketingReportSchedule").node.defaultChild as CfnSchedule;
  const scheduleStack = Stack.of(marketingSchedule);
  if (scheduleStack.resolve(marketingSchedule.scheduleExpression) !== "cron(0 8 ? * FRI *)" || scheduleStack.resolve(marketingSchedule.scheduleExpressionTimezone) !== "America/New_York") throw new Error("Marketing report must run Friday at 08:00 America/New_York, including DST");
  if (scheduleStack.resolve(marketingSchedule.state) !== (process.env.AWS_BRANCH === "main" ? "ENABLED" : "DISABLED")) throw new Error("Marketing schedule must be enabled only in production");
  const expectedArn = scheduleStack.resolve(scheduleStack.formatArn({ service: "scheduler", resource: "schedule", resourceName: `default/${marketingSchedule.name}` }));
  if (JSON.stringify(marketingEnv.variables.MARKETING_REPORT_SCHEDULE_ARN) !== JSON.stringify(expectedArn)) throw new Error("Worker must verify the actual marketing schedule ARN");
  const scheduleInput = JSON.parse(scheduleStack.resolve(marketingSchedule.target).input);
  if (scheduleInput.trigger !== "scheduled" || scheduleInput.scheduleArn !== "<aws.scheduler.schedule-arn>" || scheduleInput.scheduledAt !== "<aws.scheduler.scheduled-time>") throw new Error("Marketing schedule must provide its trusted ARN and scheduled timestamp");
  const asyncConfig = marketingWorker.node.findAll().find(node => (node as CfnEventInvokeConfig).cfnResourceType === "AWS::Lambda::EventInvokeConfig") as CfnEventInvokeConfig | undefined;
  if (!asyncConfig || asyncConfig.maximumRetryAttempts !== 0 || asyncConfig.maximumEventAgeInSeconds !== 300) throw new Error("Marketing sends must not be retried automatically after uncertain delivery");
  // CloudFormation rejects an S3 template above 1,000,000 bytes even when CDK
  // can synthesize it. Check the actual files, including every nested stack.
  const templates = (readdirSync(outdir, { recursive: true }) as string[]).filter(name => name.endsWith(".template.json"))
    .map(name => ({ name, bytes: readFileSync(join(outdir, name)).byteLength })).sort((a, b) => b.bytes - a.bytes);
  for (const template of templates) if (template.bytes > 1_000_000) throw new Error(`CloudFormation template exceeds 1,000,000 bytes: ${template.name} (${template.bytes})`);
  console.log(`Largest CloudFormation template: ${templates[0]?.bytes ?? 0} bytes (${templates[0]?.name ?? "none"}).`);
  const stacks = assembly.stacks.length;

  console.log(`✔ Backend synthesised — ${stacks} stack${stacks === 1 ? "" : "s"}.`);
} catch (err) {
  console.error("✘ Synth failed:", err instanceof Error ? err.message : err);
  console.error(
    "\nThis is what the Amplify build will report. Fix it here rather than " +
      "in a pipeline log."
  );
  process.exitCode = 1;
} finally {
  rmSync(outdir, { recursive: true, force: true });
}
