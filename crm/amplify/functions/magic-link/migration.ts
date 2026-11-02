/** Destination authentication is explicitly bound to its retained backend. */
export const MIGRATION_ACCOUNT = "917680434255";
export const MIGRATION_BRANCHES = ["codex-hoa-account-migration", "codex-hoa-staging-migration"];
export const REQUEST_LINK = "REQUEST_LINK";

type AuthEvent = {
  region: string;
  userPoolId: string;
  userName: string;
  triggerSource: string;
  callerContext: { clientId: string };
  request: { userAttributes: Record<string, string>; userNotFound?: boolean };
};
type Invocation = { invokedFunctionArn: string };

export const destinationAuth = () => process.env.HOA_MIGRATION_AUTH === "true";
export const migrationPreview = () => process.env.HOA_MIGRATION_PREVIEW === "true";

export function assertMigrationAuth(event: AuthEvent, context: Invocation) {
  if (!destinationAuth() && !migrationPreview()) return;
  const env = process.env;
  const app = env.HOA_MIGRATION_APP_ID ?? "";
  const branch = env.HOA_MIGRATION_BRANCH ?? "";
  const pool = env.HOA_PREVIEW_ADMIN_USER_POOL_ID ?? "";
  const client = env.HOA_PREVIEW_ADMIN_CLIENT_ID ?? "";
  const trigger = ["DefineAuthChallenge_Authentication", "CreateAuthChallenge_Authentication", "VerifyAuthChallengeResponse_Authentication"];
  if (!destinationAuth() || !/^[a-z0-9]+$/.test(app)
    || !MIGRATION_BRANCHES.includes(branch)
    || !context.invokedFunctionArn.startsWith(`arn:aws:lambda:us-east-1:${MIGRATION_ACCOUNT}:function:amplify-${app}-`)
    || event.region !== "us-east-1" || !pool.startsWith("us-east-1_")
    || event.userPoolId !== pool || !client || event.callerContext.clientId !== client
    || !trigger.includes(event.triggerSource) || event.request.userNotFound
    || event.request.userAttributes.email_verified !== "true") {
    throw new Error("Migration authentication is not configured for this request.");
  }
  if (!migrationPreview()) return;
  const expiry = Date.parse(env.HOA_PREVIEW_ADMIN_LOGIN_EXPIRES_AT ?? "");
  if (branch !== "codex-hoa-account-migration" || env.HOA_PREVIEW_ADMIN_LOGIN !== "true"
    || !Number.isFinite(expiry) || Date.now() >= expiry
    || !env.HOA_PREVIEW_ADMIN_USERNAME || event.userName !== env.HOA_PREVIEW_ADMIN_USERNAME
    || env.HOA_PREVIEW_ADMIN_EMAIL !== "jake@getgim.com"
    || event.request.userAttributes.email?.toLowerCase() !== env.HOA_PREVIEW_ADMIN_EMAIL
    || env.MAGIC_LINK_BASE_URL !== `https://migration.${app}.amplifyapp.com`
    || env.MAGIC_LINK_FROM !== "HOA Insurance Agency <noreply@protectmyhoa.com>"
    || (env.HOA_TRANSACTIONAL_MAIL_PROVIDER === "resend" ? env.HOA_RESEND_PREVIEW_ENABLED !== "true" : env.HOA_PREVIEW_SES_CONFIGURATION_SET !== "hoa-migration-preview-20261029")) {
    throw new Error("Administrator sign-in is disabled in this migration preview.");
  }
}
