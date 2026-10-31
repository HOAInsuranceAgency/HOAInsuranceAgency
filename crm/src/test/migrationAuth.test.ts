import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertMigrationAuth } from "../../amplify/functions/magic-link/migration";
import { handler as create } from "../../amplify/functions/magic-link/create";
import { handler as verify } from "../../amplify/functions/magic-link/verify";
import { handler as define } from "../../amplify/functions/magic-link/define";
import { handler as nativeMessage } from "../../amplify/functions/magic-link/native-message";

const sendDestinationLink = vi.hoisted(() => vi.fn());
const getSigningSecret = vi.hoisted(() => vi.fn());
const verifyToken = vi.hoisted(() => vi.fn());
vi.mock("../../amplify/functions/magic-link/send", () => ({ sendDestinationLink }));
vi.mock("../../amplify/functions/magic-link/token", () => ({ getSigningSecret, verifyToken, mintToken: vi.fn() }));

const context = { invokedFunctionArn: "arn:aws:lambda:us-east-1:917680434255:function:amplify-dtesthoa-co-magiclink" };
function event(triggerSource = "CreateAuthChallenge_Authentication") {
  return {
    region: "us-east-1", userPoolId: "us-east-1_preview", userName: "owner-id", triggerSource,
    callerContext: { clientId: "preview-client" },
    request: { userAttributes: { email: "jake@getgim.com", email_verified: "true" }, userNotFound: false, challengeAnswer: "valid-token", session: [] as unknown[] },
    response: {} as Record<string, unknown>,
  };
}
const environment = {
  HOA_MIGRATION_AUTH: "true", HOA_MIGRATION_PREVIEW: "true", HOA_MIGRATION_APP_ID: "dtesthoa",
  HOA_MIGRATION_BRANCH: "codex-hoa-account-migration", HOA_PREVIEW_ADMIN_LOGIN: "true",
  HOA_PREVIEW_ADMIN_USER_POOL_ID: "us-east-1_preview", HOA_PREVIEW_ADMIN_CLIENT_ID: "preview-client",
  HOA_PREVIEW_ADMIN_USERNAME: "owner-id", HOA_PREVIEW_ADMIN_EMAIL: "jake@getgim.com",
  HOA_PREVIEW_ADMIN_LOGIN_EXPIRES_AT: "2099-01-01T00:00:00Z",
  MAGIC_LINK_BASE_URL: "https://migration.dtesthoa.amplifyapp.com",
  MAGIC_LINK_FROM: "HOA Insurance Agency <noreply@protectmyhoa.com>",
  HOA_PREVIEW_SES_CONFIGURATION_SET: "hoa-migration-preview-20261029",
};
beforeEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
  getSigningSecret.mockResolvedValue("test-secret"); verifyToken.mockReturnValue(true);
});
afterEach(() => vi.unstubAllEnvs());

describe("destination preview authentication guard", () => {
  it("allows only the exact configured owner binding", () => expect(() => assertMigrationAuth(event(), context)).not.toThrow());
  it.each([
    ["HOA_MIGRATION_AUTH", "false"], ["HOA_PREVIEW_ADMIN_LOGIN", "false"],
    ["HOA_MIGRATION_BRANCH", "codex-hoa-staging-migration"],
    ["HOA_MIGRATION_APP_ID", "other-app"], ["HOA_PREVIEW_ADMIN_USER_POOL_ID", "other-pool"],
    ["HOA_PREVIEW_ADMIN_CLIENT_ID", "other-client"], ["HOA_PREVIEW_ADMIN_USERNAME", "other-user"],
    ["HOA_PREVIEW_ADMIN_EMAIL", "other@example.test"], ["HOA_PREVIEW_ADMIN_LOGIN_EXPIRES_AT", "2020-01-01"],
    ["HOA_PREVIEW_ADMIN_LOGIN_EXPIRES_AT", "invalid"], ["MAGIC_LINK_BASE_URL", "https://app.protectmyhoa.com"],
    ["MAGIC_LINK_FROM", "other@protectmyhoa.com"], ["HOA_PREVIEW_SES_CONFIGURATION_SET", "other"],
  ])("refuses an invalid %s", (key, value) => {
    vi.stubEnv(key, value); expect(() => assertMigrationAuth(event(), context)).toThrow();
    expect(sendDestinationLink).not.toHaveBeenCalled();
  });
  it("refuses source account invocation", () => expect(() => assertMigrationAuth(event(), { invokedFunctionArn: context.invokedFunctionArn.replace("917680434255", "637423611040") })).toThrow());
  it("refuses wrong region, trigger, missing user and unverified email", () => {
    for (const alter of [(e: ReturnType<typeof event>) => { e.region = "us-west-2"; }, (e: ReturnType<typeof event>) => { e.triggerSource = "Wrong"; }, (e: ReturnType<typeof event>) => { e.request.userNotFound = true; }, (e: ReturnType<typeof event>) => { e.request.userAttributes.email_verified = "false"; }]) {
      const e = event(); alter(e); expect(() => assertMigrationAuth(e, context)).toThrow();
    }
  });
  it("does not apply destination policy to unchanged source auth", () => {
    vi.stubEnv("HOA_MIGRATION_AUTH", "false"); vi.stubEnv("HOA_MIGRATION_PREVIEW", "false");
    expect(() => assertMigrationAuth(event(), { invokedFunctionArn: "source" })).not.toThrow();
  });
});

it("never sends a link from destination InitiateAuth or consume challenge creation", async () => {
  const e = event(); await create(e as never, context as never, () => {});
  expect(e.response.challengeMetadata).toBe("MAGIC_LINK"); expect(sendDestinationLink).not.toHaveBeenCalled();
});
it("sends one link only for the explicit destination request answer", async () => {
  const e = event("VerifyAuthChallengeResponse_Authentication"); e.request.challengeAnswer = "REQUEST_LINK";
  await verify(e as never, context as never, () => {});
  expect(sendDestinationLink).toHaveBeenCalledExactlyOnceWith("jake@getgim.com"); expect(e.response.answerCorrect).toBe(false); expect(getSigningSecret).not.toHaveBeenCalled();
});
it("consumes a token without sending another email", async () => {
  const e = event("VerifyAuthChallengeResponse_Authentication"); await verify(e as never, context as never, () => {});
  expect(e.response.answerCorrect).toBe(true); expect(sendDestinationLink).not.toHaveBeenCalled();
});
it("refuses unauthorized requests before token, secret or email access", async () => {
  const e = event("VerifyAuthChallengeResponse_Authentication"); e.userName = "other"; e.request.challengeAnswer = "REQUEST_LINK";
  await expect(verify(e as never, context as never, () => {})).rejects.toThrow();
  expect(sendDestinationLink).not.toHaveBeenCalled(); expect(getSigningSecret).not.toHaveBeenCalled();
});
it("refuses token issuance when the administrator test has expired", async () => {
  vi.stubEnv("HOA_PREVIEW_ADMIN_LOGIN_EXPIRES_AT", "2020-01-01"); const e = event("DefineAuthChallenge_Authentication");
  e.request.session = [{ challengeName: "CUSTOM_CHALLENGE", challengeResult: true }];
  await expect(define(e as never, context as never, () => {})).rejects.toThrow();
});
it("blocks native invitation and recovery messages in preview", async () => {
  await expect(nativeMessage({} as never, {} as never, () => {})).rejects.toThrow("Native user email");
});
