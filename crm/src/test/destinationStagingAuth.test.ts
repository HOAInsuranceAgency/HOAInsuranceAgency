import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, Stack } from "aws-cdk-lib";
import { CfnUserPool, CfnUserPoolClient } from "aws-cdk-lib/aws-cognito";

const mode = vi.hoisted(() => ({ destination: true, branch: "staging", preview: false }));
vi.mock("../../amplify/migration-config", () => ({
  get migrationDestination() { return mode.destination; },
  get businessBranch() { return mode.branch; },
  get migrationPreview() { return mode.preview; },
  migrationCrmOrigin: "https://migration-staging.d1nuh9rw1hcuxo.amplifyapp.com",
}));
vi.mock("@aws-amplify/backend", () => ({
  defineAuth: (definition: unknown) => definition,
  defineFunction: (definition: { name: string }) => ({ name: definition.name }),
  secret: (name: string) => ({ secret: name }),
}));

beforeEach(() => {
  vi.resetModules(); mode.destination = true; mode.branch = "staging"; mode.preview = false;
  vi.stubEnv("GOOGLE_SIGN_IN_ENABLED", "false"); vi.stubEnv("AWS_BRANCH", "codex-hoa-staging-migration");
  vi.stubEnv("HOA_MIGRATION_PREVIEW", "false");
});
afterEach(() => vi.unstubAllEnvs());

async function definition() {
  const config = await import("../../amplify/auth/config");
  const resource = await import("../../amplify/auth/resource");
  return { config, auth: resource.auth as unknown as {
    userAttributes?: Record<string, unknown>; triggers: Record<string, unknown>;
    loginWith: { email: boolean; externalProviders?: unknown }; groups: string[];
  } };
}
function nativeBackend() {
  const app = new App(); const stack = new Stack(app, "AuthBoundary");
  const pool = new CfnUserPool(stack, "Pool", {
    adminCreateUserConfig: { allowAdminCreateUserOnly: true },
    lambdaConfig: { defineAuthChallenge: "native-define", createAuthChallenge: "native-create", verifyAuthChallengeResponse: "native-verify" },
  });
  const client = new CfnUserPoolClient(stack, "Client", {
    userPoolId: pool.ref, explicitAuthFlows: ["ALLOW_CUSTOM_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"], supportedIdentityProviders: ["COGNITO"],
  });
  return { pool, client, backend: { stack, auth: { resources: { cfnResources: { cfnUserPool: pool, cfnUserPoolClient: client } } } } };
}

describe("retained destination staging native authentication", () => {
  it("keeps the historical pool free of the immutable Google attribute and linking trigger", async () => {
    const { config, auth } = await definition();
    expect(config.destinationStagingNativeAuth).toBe(true); expect(config.googleSignInEnabled).toBe(false);
    expect(config.crmBaseUrl).toBe("https://migration-staging.d1nuh9rw1hcuxo.amplifyapp.com");
    expect(auth).not.toHaveProperty("userAttributes"); expect(auth.loginWith).toEqual({ email: true });
    expect(Object.keys(auth.triggers).sort()).toEqual(["createAuthChallenge", "defineAuthChallenge", "verifyAuthChallengeResponse"]);
    expect(auth.groups).toEqual(["OWNER", "ADMIN", "STAFF", "PRODUCER"]);
  });
  it.each([false, true])("rejects enabling Google on destination staging even with preview=%s", async preview => {
    mode.preview = preview; vi.stubEnv("GOOGLE_SIGN_IN_ENABLED", "true");
    await expect(definition()).rejects.toThrow("separate reviewed migration");
  });
  it.each([false, true])("retains the established main Google schema and linking guard when enabled=%s", async enabled => {
    mode.branch = "main"; vi.stubEnv("AWS_BRANCH", "main"); vi.stubEnv("GOOGLE_SIGN_IN_ENABLED", String(enabled));
    const { config, auth } = await definition();
    expect(config.destinationStagingNativeAuth).toBe(false); expect(config.googleSignInEnabled).toBe(enabled);
    expect(auth.userAttributes).toEqual({ "custom:googleHostedDomain": { dataType: "String", mutable: true } });
    expect(auth.triggers).toHaveProperty("preSignUp"); expect(!!auth.loginWith.externalProviders).toBe(enabled);
  });
  it("does not change a non-destination staging environment", async () => {
    mode.destination = false; vi.stubEnv("AWS_BRANCH", "staging");
    const { config, auth } = await definition();
    expect(config.destinationStagingNativeAuth).toBe(false); expect(auth.triggers).toHaveProperty("preSignUp");
    expect(auth.userAttributes).toHaveProperty("custom:googleHostedDomain");
  });
  it("accepts the actual native shape in the synth checker", async () => {
    const { checkGoogleSignIn } = await import("../../scripts/check-google-sign-in");
    expect(() => checkGoogleSignIn(nativeBackend().backend as never)).not.toThrow();
  });
  it.each(["attribute", "trigger", "function", "provider", "password-flow"])("rejects a new %s in the retained staging pool", async variant => {
    const { checkGoogleSignIn } = await import("../../scripts/check-google-sign-in");
    const { pool, client, backend } = nativeBackend();
    if (variant === "attribute") pool.schema = [{ name: "googleHostedDomain", attributeDataType: "String", mutable: true }];
    if (variant === "trigger") pool.lambdaConfig = { ...pool.lambdaConfig as CfnUserPool.LambdaConfigProperty, preSignUp: "new-google-trigger" };
    if (variant === "function") Object.assign(backend, { googleSignIn: { resources: { lambda: { functionArn: "new-google-function" } } } });
    if (variant === "provider") client.supportedIdentityProviders = ["Google"];
    if (variant === "password-flow") client.explicitAuthFlows = ["ALLOW_CUSTOM_AUTH", "ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_PASSWORD_AUTH"];
    expect(() => checkGoogleSignIn(backend as never)).toThrow();
  });
});
