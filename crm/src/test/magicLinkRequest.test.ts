import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOKEN_TTL_MS, mintToken, verifyToken } from "../../amplify/functions/magic-link/token";
import { destinationLinkRequest, sendDestinationLink } from "../../amplify/functions/magic-link/send";
import { handler as create } from "../../amplify/functions/magic-link/create";
import { handler as verify } from "../../amplify/functions/magic-link/verify";

const h = vi.hoisted(() => ({ mail: vi.fn(), legacy: vi.fn(), secret: vi.fn() }));
vi.mock("../../amplify/functions/transactional-mail/client", () => ({ TransactionalMailClient: class { send = h.mail; } }));
vi.mock("@aws-sdk/client-secrets-manager", () => ({ SecretsManagerClient: class { send = h.secret; }, GetSecretValueCommand: class { constructor(public input: unknown) {} } }));
vi.mock("@aws-sdk/client-sesv2", () => ({ SESv2Client: class { send = h.legacy; }, SendEmailCommand: class { constructor(public input: unknown) {} } }));

const EMAIL = "jake@getgim.com";
const SECRET = "synthetic-signing-secret-only";
const NOW = Date.parse("2026-11-04T02:00:00Z");
const REQUEST_ID = "c8b307f1-8658-4f6a-a3ee-fc17e34ce15e";
const context = { invokedFunctionArn: "arn:aws:lambda:us-east-1:917680434255:function:amplify-dtesthoa-auth-link" };
function parameters(requestId = REQUEST_ID, issuedAt = NOW) {
  return { mode: "destination", requestId, issuedAt: String(issuedAt) };
}
function event(answer = "REQUEST_LINK", privateParameters: Record<string, string> = parameters()) {
  return {
    region: "us-east-1", userPoolId: "us-east-1_test", userName: "owner-id", triggerSource: "VerifyAuthChallengeResponse_Authentication",
    callerContext: { clientId: "test-client" },
    request: { userAttributes: { email: EMAIL, email_verified: "true" }, userNotFound: false, challengeAnswer: answer, privateChallengeParameters: privateParameters, clientMetadata: {} as Record<string, string> },
    response: {} as Record<string, unknown>,
  };
}
function captured(index = 0) {
  const [command, details] = h.mail.mock.calls[index];
  return { input: command.input, details };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW); vi.clearAllMocks();
  for (const [key, value] of Object.entries({ HOA_MIGRATION_AUTH: "true", HOA_MIGRATION_PREVIEW: "false", HOA_MIGRATION_APP_ID: "dtesthoa", HOA_MIGRATION_BRANCH: "codex-hoa-account-migration", HOA_PREVIEW_ADMIN_USER_POOL_ID: "us-east-1_test", HOA_PREVIEW_ADMIN_CLIENT_ID: "test-client", MAGIC_LINK_BASE_URL: "https://app.protectmyhoa.com", MAGIC_LINK_FROM: "HOA Insurance Agency <noreply@protectmyhoa.com>" })) vi.stubEnv(key, value);
  h.secret.mockResolvedValue({ SecretString: SECRET }); h.mail.mockResolvedValue({ MessageId: "accepted-message" }); h.legacy.mockResolvedValue({ MessageId: "legacy-message" });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("destination login challenge identity", () => {
  it("creates private stable request metadata without a secret lookup or email", async () => {
    const first = event(); first.triggerSource = "CreateAuthChallenge_Authentication";
    const second = event(); second.triggerSource = "CreateAuthChallenge_Authentication";
    await create(first as never, context as never, () => {}); await create(second as never, context as never, () => {});
    const firstPrivate = first.response.privateChallengeParameters as Record<string, string>;
    const secondPrivate = second.response.privateChallengeParameters as Record<string, string>;
    expect(first.response.publicChallengeParameters).toEqual({ mode: "destination" });
    expect(destinationLinkRequest(firstPrivate)).toEqual({ requestId: firstPrivate.requestId, issuedAt: NOW });
    expect(firstPrivate.requestId).not.toBe(secondPrivate.requestId);
    expect(h.secret).not.toHaveBeenCalled(); expect(h.mail).not.toHaveBeenCalled(); expect(h.legacy).not.toHaveBeenCalled();
  });
  it("same-challenge accepted re-entry has identical token, envelope and business operation key", async () => {
    await verify(event() as never, context as never, () => {});
    const first = captured();
    vi.setSystemTime(NOW + 20_000);
    await verify(event() as never, context as never, () => {});
    expect(captured(1)).toEqual(first);
    expect(first.details.idempotencyKey).toBe(`login-request:${REQUEST_ID}`);
    const link = first.input.Content.Simple.Body.Text.Data.match(/https:\/\/\S+/)?.[0];
    const token = decodeURIComponent(new URL(link).hash.slice("#magic=".length));
    expect(verifyToken(token, EMAIL, SECRET)).toBe(true);
    const decoded = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
    expect(decoded).toEqual({ email: EMAIL, exp: NOW + TOKEN_TTL_MS });
  });
  it("same-challenge ambiguous re-entry retains the identical envelope and key without a legacy fallback", async () => {
    h.mail.mockRejectedValue(Object.assign(new Error("uncertain provider acceptance"), { state: "UNKNOWN" }));
    await expect(verify(event() as never, context as never, () => {})).rejects.toMatchObject({ state: "UNKNOWN" });
    const first = captured();
    vi.setSystemTime(NOW + 5_000);
    await expect(verify(event() as never, context as never, () => {})).rejects.toMatchObject({ state: "UNKNOWN" });
    expect(captured(1)).toEqual(first); expect(h.legacy).not.toHaveBeenCalled();
  });
  it("a new Cognito challenge gets an independent operation while retaining token format", async () => {
    await sendDestinationLink(EMAIL, parameters());
    await sendDestinationLink(EMAIL, parameters("d79f3485-f3e4-40d0-91bc-a83019dfb62a", NOW));
    expect(captured().details.idempotencyKey).not.toBe(captured(1).details.idempotencyKey);
    expect(Object.keys(JSON.parse(Buffer.from(mintToken(EMAIL, SECRET, NOW).split(".")[0], "base64url").toString()))).toEqual(["email", "exp"]);
  });
  it.each([
    undefined, {}, { mode: "destination" }, { ...parameters(), mode: "request" },
    { ...parameters(), requestId: "not-a-private-request-id" },
    { ...parameters(), requestId: "c8b307f1-8658-1f6a-a3ee-fc17e34ce15e" },
    { ...parameters(), issuedAt: "invalid" }, { ...parameters(), issuedAt: "1e12" },
    { ...parameters(), issuedAt: "-1" }, { ...parameters(), issuedAt: `0${NOW}` },
    { ...parameters(), issuedAt: String(NOW - TOKEN_TTL_MS) },
    { ...parameters(), issuedAt: String(NOW + 5_001) },
  ])("refuses missing, malformed, expired or future request metadata before secret/email access: %j", async value => {
    await expect(sendDestinationLink(EMAIL, value as never)).rejects.toThrow("fresh sign-in link");
    expect(h.mail).not.toHaveBeenCalled(); expect(h.legacy).not.toHaveBeenCalled(); expect(h.secret).not.toHaveBeenCalled();
  });
  it("accepts bounded Lambda-host clock skew without changing its frozen expiration", () => {
    expect(destinationLinkRequest(parameters(REQUEST_ID, NOW + 5_000))).toEqual({ requestId: REQUEST_ID, issuedAt: NOW + 5_000 });
  });
  it("old in-flight destination REQUEST_LINK fails closed, but an existing emailed token still consumes", async () => {
    await expect(verify(event("REQUEST_LINK", {}) as never, context as never, () => {})).rejects.toThrow("fresh sign-in link");
    const token = mintToken(EMAIL, SECRET, NOW - 60_000);
    const consume = event(token, {});
    await verify(consume as never, context as never, () => {});
    expect(consume.response.answerCorrect).toBe(true); expect(h.mail).not.toHaveBeenCalled(); expect(h.legacy).not.toHaveBeenCalled();
  });
  it("legacy/source creation keeps its existing direct-send metadata and token path", async () => {
    vi.stubEnv("HOA_MIGRATION_AUTH", "false"); vi.stubEnv("HOA_MIGRATION_PREVIEW", "false");
    const source = event(); source.triggerSource = "CreateAuthChallenge_Authentication";
    await create(source as never, context as never, () => {});
    expect(source.response.privateChallengeParameters).toEqual({ mode: "request" });
    expect(h.legacy).toHaveBeenCalledTimes(1); expect(h.mail).not.toHaveBeenCalled();
  });
});
