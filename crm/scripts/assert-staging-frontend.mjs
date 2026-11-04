// Temporary integration-branch guard. This script performs read-only AWS calls.
// It must never be promoted into a production PR or used for a backend deploy.
import { readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ACCOUNT = "917680434255", REGION = "us-east-1", APP = "d1nuh9rw1hcuxo";
const RUNTIME = "codex-hoa-staging-migration", NAMESPACE = "staging";
const ROOT = "arn:aws:cloudformation:us-east-1:917680434255:stack/amplify-d1nuh9rw1hcuxo-staging-branch-3787a09124/eaa4dff0-d3d3-11f1-ab1d-0edee65f4629";
const AUTH_STACK = "arn:aws:cloudformation:us-east-1:917680434255:stack/amplify-d1nuh9rw1hcuxo-staging-branch-3787a09124-auth179371D7-FDPQ0BOUAQ50/f4e514d0-d3d3-11f1-a9d4-0affea1664f5";
const POOL = "us-east-1_6tQkvfLuD", CLIENT = "3vssvrvmdglqcoh6e1r133k6ln";
const API = "https://6ibyan35zrfixjwpspnoi6dc2q.appsync-api.us-east-1.amazonaws.com/graphql";
const ORIGIN = "https://migration-staging.d1nuh9rw1hcuxo.amplifyapp.com";
const stable = status => ["CREATE_COMPLETE", "UPDATE_COMPLETE"].includes(status);
class GuardError extends Error {}
function requireCondition(ok, message) { if (!ok) throw new GuardError(message); }
function aws(service, operation, ...args) {
  // Deliberately no arbitrary operation passthrough or mutation capability.
  const allowed = new Set(["sts:get-caller-identity", "amplify:get-branch", "cloudformation:describe-stacks", "cloudformation:list-stack-resources", "cloudformation:get-template"]);
  requireCondition(allowed.has(`${service}:${operation}`), "Only read-only staging metadata operations are allowed.");
  try {
    const raw = execFileSync("aws", [service, operation, ...args, "--region", REGION, "--output", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, AWS_PAGER: "" }, maxBuffer: 10 * 1024 * 1024 });
    return JSON.parse(raw);
  } catch (error) {
    const code = /An error occurred \(([A-Za-z0-9_]+)\)/.exec(String(error?.stderr ?? ""))?.[1]
      ?? String(error?.code ?? error?.name ?? "Error").replace(/[^A-Za-z0-9_]/g, "");
    throw new GuardError(`Read-only staging check failed: ${service}/${operation} (${code}).`);
  }
}
function resources(stack) {
  const result = []; let token;
  for (let page = 0; page < 100; page++) {
    const next = aws("cloudformation", "list-stack-resources", "--stack-name", stack, ...(token ? ["--next-token", token] : []));
    result.push(...(next.StackResourceSummaries ?? []));
    if (!next.NextToken) return result;
    requireCondition(next.NextToken !== token, "Staging resource inventory did not advance.");
    token = next.NextToken;
  }
  throw new GuardError("Staging resource inventory exceeded its bounded read.");
}
function releasedFrontend(env) {
  return env.HOA_DEPLOY_ACCOUNT_ID === ACCOUNT && env.HOA_MIGRATION_AUTH === "true" && env.HOA_MIGRATION_PREVIEW === "false"
    && env.VITE_HOA_MIGRATION_AUTH === "true" && env.VITE_HOA_MIGRATION_PREVIEW === "false";
}
function guard() {
  const args = process.argv.slice(2);
  requireCondition(args.length === 1 && args[0] === "--before-outputs" || args.length === 2 && args[0] === "--outputs", "Use --before-outputs or --outputs path/to/amplify_outputs.json.");
  requireCondition(process.env.AWS_APP_ID === APP && process.env.AWS_BRANCH === RUNTIME && process.env.AMPLIFY_MONOREPO_APP_ROOT === "crm", "This temporary frontend build is restricted to the business CRM staging hosted branch.");
  requireCondition(releasedFrontend(process.env), "The frontend must retain released staging authentication and preview=false.");
  requireCondition(aws("sts", "get-caller-identity").Account === ACCOUNT, "AWS identity does not belong to the business staging account.");
  // The Hosting service role can read only dormant namespace branches and CF
  // metadata. The operator's pre/post fingerprint additionally checks the app,
  // runtime branch, live Cognito configuration and all Lambda environments.
  const namespace = aws("amplify", "get-branch", "--app-id", APP, "--branch-name", NAMESPACE).branch;
  requireCondition(namespace?.branchName === NAMESPACE && namespace.backend?.stackArn === ROOT && namespace.enableAutoBuild === false && namespace.enablePullRequestPreview !== true, "The existing staging backend namespace must remain dormant and unchanged.");
  const stack = aws("cloudformation", "describe-stacks", "--stack-name", ROOT).Stacks?.[0];
  requireCondition(stack?.StackId === ROOT && stable(stack.StackStatus) && stack.EnableTerminationProtection === true, "The retained staging backend is not stable or protected.");
  const auth = resources(ROOT).find(item => item.LogicalResourceId === "auth179371D7" && item.ResourceType === "AWS::CloudFormation::Stack");
  requireCondition(auth?.PhysicalResourceId === AUTH_STACK && stable(auth.ResourceStatus), "The staging auth child differs from the retained backend.");
  const authResources = resources(AUTH_STACK);
  requireCondition(authResources.some(item => item.ResourceType === "AWS::Cognito::UserPool" && item.PhysicalResourceId === POOL && stable(item.ResourceStatus)) && authResources.some(item => item.ResourceType === "AWS::Cognito::UserPoolClient" && item.PhysicalResourceId === CLIENT && stable(item.ResourceStatus)), "The expected staging pool/client are not owned by this backend.");
  const templateResponse = aws("cloudformation", "get-template", "--stack-name", AUTH_STACK, "--template-stage", "Original");
  const template = typeof templateResponse.TemplateBody === "string" ? JSON.parse(templateResponse.TemplateBody) : templateResponse.TemplateBody;
  const poolResource = template?.Resources?.amplifyAuthUserPool4BA7F805;
  const clientResource = template?.Resources?.amplifyAuthUserPoolAppClient2626C6F8;
  const pool = poolResource?.Properties, client = clientResource?.Properties;
  requireCondition(poolResource?.Type === "AWS::Cognito::UserPool" && pool?.AdminCreateUserConfig?.AllowAdminCreateUserOnly === true, "The retained staging pool template must remain invite-only.");
  requireCondition(["CreateAuthChallenge", "DefineAuthChallenge", "VerifyAuthChallengeResponse"].every(name => pool.LambdaConfig?.[name]), "The retained staging pool template is missing a native sign-in trigger.");
  requireCondition(clientResource?.Type === "AWS::Cognito::UserPoolClient" && JSON.stringify(client?.UserPoolId) === JSON.stringify({ Ref: "amplifyAuthUserPool4BA7F805" }) && client.GenerateSecret !== true && client.RefreshTokenValidity === 7 && JSON.stringify([...(client.ExplicitAuthFlows ?? [])].sort()) === JSON.stringify(["ALLOW_CUSTOM_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]), "The retained staging browser-client template or native sign-in flow changed.");
  if (args[0] === "--outputs") {
    const info = statSync(args[1]);
    requireCondition(info.isFile() && info.size > 1 && info.size < 5 * 1024 * 1024, "Expected a small generated Amplify outputs file.");
    const outputs = JSON.parse(readFileSync(args[1], "utf8")), migration = outputs.custom?.migration;
    requireCondition(outputs.auth?.aws_region === REGION && outputs.auth.user_pool_id === POOL && outputs.auth.user_pool_client_id === CLIENT && outputs.data?.url === API && migration?.account === ACCOUNT && migration.appId === APP && migration.branch === RUNTIME && migration.preview === "false" && outputs.custom?.frontSidebarUrl === `${ORIGIN}/front-sidebar`, "Generated outputs do not belong to the retained, released staging backend and origin.");
  }
  console.log(JSON.stringify({ account: ACCOUNT, appId: APP, hostedBranch: RUNTIME, backendBranch: NAMESPACE, poolId: POOL, clientId: CLIENT, graphqlUrl: API, url: ORIGIN, generatedOutputsVerified: args[0] === "--outputs", backendDeployment: false }));
}
try { guard(); }
catch (error) {
  // Never print AWS response objects, branch environments, receipt values,
  // Lambda environment values, client secrets or subprocess stdout/stderr.
  console.error(error instanceof GuardError ? error.message : `Staging frontend guard failed (${String(error?.name ?? "Error").replace(/[^A-Za-z0-9_]/g, "")}).`);
  process.exitCode = 1;
}
