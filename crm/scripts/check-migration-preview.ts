import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Stack, CfnResource } from "aws-cdk-lib";
import { migrationStreamPhase, businessBranch } from "../amplify/migration-config";
import { PREVIEW_DENIED_ACTIONS } from "../amplify/migration-preview";

type Resource = { Type: string; Properties?: Record<string, any> };
export function checkMigrationPreview(backend: any, outdir: string) {
  const templates = readdirSync(outdir, { recursive: true }).filter(name => String(name).endsWith(".template.json"))
    .map(name => JSON.parse(readFileSync(join(outdir, String(name)), "utf8")));
  const resources: Resource[] = templates.flatMap(t => Object.values(t.Resources ?? {}) as Resource[]);
  const require = (ok: unknown, reason: string) => { if (!ok) throw new Error(`Unsafe migration preview: ${reason}`); };
  let mutations = 0, mappings = 0, schedules = 0;
  for (const r of resources) {
    const p = r.Properties ?? {};
    if (r.Type === "Custom::AmplifyBranchLinkerResource") require(p.branchName === businessBranch, "backend namespace does not match its Amplify branch link");
    if (r.Type === "AWS::AppSync::Resolver" && p.TypeName === "Mutation") {
      mutations++; require(JSON.stringify(p.RequestMappingTemplate ?? p.Code ?? "").includes("MigrationPreviewReadOnly"), `unguarded mutation ${p.FieldName}`);
    }
    if (r.Type === "AWS::Lambda::EventSourceMapping") { mappings++; require(p.Enabled === (migrationStreamPhase === "armed"), "wrong stream phase"); if (migrationStreamPhase === "armed") require(p.StartingPosition === "LATEST", "armed stream without fresh LATEST cursor"); }
    if (["AWS::Scheduler::Schedule", "AWS::Events::Rule"].includes(r.Type)) { schedules++; require(p.State === "DISABLED", "enabled schedule"); }
    if (r.Type === "Custom::S3BucketNotifications" || r.Type === "AWS::S3::Bucket") require(!Object.keys(p.NotificationConfiguration ?? {}).length, "S3 events enabled");
    if (r.Type === "AWS::Lambda::Url") require(p.AuthType === "AWS_IAM", "public webhook URL");
    if (r.Type === "AWS::Lambda::Permission" && p.Principal === "*") require(false, "public Lambda permission");
    if (r.Type === "AWS::CloudWatch::Alarm") require(p.ActionsEnabled === false, "alarm notifications enabled");
    if (r.Type === "AWS::Lambda::Function") {
      const env = p.Environment?.Variables ?? {};
      require(!Object.keys(env).some(k => /^(ANTHROPIC_API_KEY|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|HONEYCOMB_API_)/.test(k)), "live provider secret configured");
    }
  }
  require(mutations > 100 && mappings >= 22 && schedules >= 8, "expected writer inventory missing from synth");
  const auth = new Set(["magicLinkDefine", "magicLinkCreate", "magicLinkVerify", "migrationNativeMessage"]);
  const reads = new Set(["crmAccess", "communications", "commissions", "ownerProfitability", "migrateProducerLicenses"]);
  const guard = backend.stack.node.root.node.findAll().find((n: any) => n.node.id === "ReadOnlyBusinessFunctions");
  require(guard, "missing shared preview deny policy");
  const guardResource = guard.node.defaultChild as CfnResource, guardStack = Stack.of(guardResource);
  const guardTemplate = JSON.parse(readFileSync(join(outdir, guardStack.templateFile), "utf8"));
  const guardStatements = guardTemplate.Resources[guardStack.getLogicalId(guardResource)].Properties.PolicyDocument.Statement;
  const denied = new Set(guardStatements.filter((s: any) => s.Effect === "Deny" && [s.Resource].flat().includes("*")).flatMap((s: any) => [s.Action].flat()));
  require(PREVIEW_DENIED_ACTIONS.every(a => denied.has(a)), "shared preview policy is incomplete");
  let functions = 0;
  for (const [name, resource] of Object.entries(backend) as [string, any][]) {
    if (!resource?.resources?.lambda || typeof resource.addEnvironment !== "function") continue;
    functions++;
    const fn = resource.resources.lambda, cfn = fn.node.defaultChild;
    const stack = Stack.of(cfn), template = JSON.parse(readFileSync(join(outdir, stack.templateFile), "utf8"));
    const deployed = template.Resources[stack.getLogicalId(cfn)];
    require(deployed.Properties.Environment.Variables.HOA_MIGRATION_PREVIEW === "true", `missing mode for ${name}`);
    if (auth.has(name)) continue;
    if (!reads.has(name)) require(deployed.Properties.ReservedConcurrentExecutions === 0, `business function enabled: ${name}`);
    const role = fn.role.node.defaultChild as CfnResource, roleStack = Stack.of(role), roleId = roleStack.getLogicalId(role);
    const roleTemplate = JSON.parse(readFileSync(join(outdir, roleStack.templateFile), "utf8"));
    const expected = JSON.stringify(roleStack.resolve(guard.managedPolicyArn));
    require((roleTemplate.Resources[roleId].Properties.ManagedPolicyArns ?? []).some((arn: unknown) => JSON.stringify(arn) === expected), `missing business write deny for ${name}`);
  }
  require(functions >= 40, "application function inventory incomplete");
  console.log(`Preview isolation verified: ${mutations} blocked mutations, ${mappings} ${migrationStreamPhase === "armed" ? "armed LATEST" : "disabled"} streams, ${schedules} disabled schedules, ${functions} guarded functions.`);
}
