import { createHmac } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../amplify/functions/communications/budget", () => ({ authorizationDelay: async () => 0, authorizationFailed: async () => 60, authorizationRestored: async () => {}, remainingDelay: async () => 0, rememberBudget: async () => {} }));
vi.mock("../../amplify/functions/communications/config", () => ({ credentials: async () => ({ frontToken: "test-secret", dialpadToken: "test-secret" }), config: async () => ({ environment: "staging", frontInboxId: "inb_a", allowedInboxIds: [], frontChannelId: "cha_a", frontSender: "test@example.com", testRecipients: ["test@example.com"] }) }));
import { verifyFront, verifyDialpad } from "../../amplify/functions/communications/webhook";
import { providerRequest, assertRecipient, providerTimestamp, verifyEmailChannel } from "../../amplify/functions/communications/providers";
const secret = "webhook-signing-secret";
beforeEach(() => { vi.stubGlobal("fetch", h.fetch); h.fetch.mockReset(); });
afterEach(() => vi.unstubAllGlobals());
describe("signed provider receipts", () => {
  it("verifies the exact Front body and timestamp, rejecting tampering and replay", () => {
    const raw = JSON.stringify({ type: "inbound", authorization: { id: "cmp_a" } }), time = Date.now();
    const headers = { "x-front-request-timestamp": String(time), "x-front-signature": createHmac("sha256", secret).update(`${time}:${raw}`).digest("base64") };
    expect(verifyFront(raw, headers, secret, time).type).toBe("inbound");
    expect(() => verifyFront(raw + " ", headers, secret, time)).toThrow("Invalid"); expect(() => verifyFront(raw, headers, secret, time + 300001)).toThrow("Expired");
  });
  function jwt(header: unknown, payload: unknown) { const a = Buffer.from(JSON.stringify(header)).toString("base64url"), b = Buffer.from(JSON.stringify(payload)).toString("base64url"); return `${a}.${b}.${createHmac("sha256", secret).update(`${a}.${b}`).digest("base64url")}`; }
  it("requires HS256 and verifies Dialpad payloads before decoding them", () => {
    expect(verifyDialpad(jwt({ alg: "HS256" }, { call_id: 1 }), secret).call_id).toBe(1);
    expect(() => verifyDialpad(jwt({ alg: "none" }, {}), secret)).toThrow("Unsupported");
    expect(() => verifyDialpad(jwt({ alg: "HS256" }, {}), "wrong-key")).toThrow("Invalid");
    expect(() => verifyDialpad(jwt({ alg: "HS256" }, { exp: 1 }), secret)).toThrow("Expired");
  });
});
describe("provider boundaries", () => {
  it("does not send API tokens to untrusted pagination or redirect destinations", async () => {
    await expect(providerRequest("front", "https://attacker.example/messages")).rejects.toThrow("Untrusted"); expect(h.fetch).not.toHaveBeenCalled();
    h.fetch.mockResolvedValue(new Response("", { status: 301, headers: { location: "https://attacker.example/conversations/cnv_b" } }));
    await expect(providerRequest("front", "/conversations/cnv_a")).rejects.toThrow("Untrusted"); expect(h.fetch).toHaveBeenCalledTimes(1);
  });
  it("maps documented company API pagination links onto the fixed Front origin", async () => {
    h.fetch.mockResolvedValue(new Response('{"_results":[]}', { status: 200 })); await providerRequest("front", "https://company.api.frontapp.com/conversations?page_token=abc");
    expect(String(h.fetch.mock.calls[0][0])).toBe("https://api2.frontapp.com/conversations?page_token=abc");
  });
  it("does not silently follow or change a mutation on redirect", async () => {
    h.fetch.mockResolvedValue(new Response("", { status: 301, headers: { location: "https://api2.frontapp.com/conversations/cnv_b" } }));
    await expect(providerRequest("front", "/conversations/cnv_a/messages", "POST", {})).rejects.toMatchObject({ status: 301, uncertain: false }); expect(h.fetch).toHaveBeenCalledTimes(1);
  });
  it("distinguishes rate limiting from an uncertain external send", async () => {
    h.fetch.mockResolvedValue(new Response("", { status: 429, headers: { "retry-after": "17" } })); await expect(providerRequest("front", "/messages", "POST", {})).rejects.toMatchObject({ status: 429, uncertain: false, retryAfter: 17 });
    h.fetch.mockRejectedValue(new Error("timeout")); await expect(providerRequest("front", "/messages", "POST", {})).rejects.toMatchObject({ status: 0, uncertain: true });
  });
  it("enforces staging recipients", async () => { await expect(assertRecipient("test@example.com")).resolves.toBeUndefined(); await expect(assertRecipient("real@example.com")).rejects.toThrow("staging"); });
  it("holds an expired mailbox OAuth connection for repair", async () => {
    h.fetch.mockResolvedValue(new Response(JSON.stringify({ type: "gmail", address: "test@example.com", is_valid: false, _links: { related: { inbox: "https://api2.frontapp.com/inboxes/inb_a" } } })));
    await expect(verifyEmailChannel()).rejects.toMatchObject({ status: 401, uncertain: false });
  });
  it("validates actual Front email provider types and the send-as address", async () => {
    h.fetch.mockResolvedValue(new Response(JSON.stringify({ type: "gmail", address: "underlying@example.com", send_as: "test@example.com", is_valid: true, _links: { related: { inbox: "https://api2.frontapp.com/inboxes/inb_a" } } }), { status: 200 }));
    await expect(verifyEmailChannel()).resolves.toMatchObject({ type: "gmail" });
  });
  it("normalizes numeric and string Seen timestamps without a thousand-fold date error", () => {
    expect(providerTimestamp(1701298738269)).toBe(1701298738269); expect(providerTimestamp("1701298738269")).toBe(1701298738269); expect(providerTimestamp(1701298738)).toBe(1701298738000);
  });
});

describe("CRM authorization", () => {
  it("requires CRM authentication even if a caller supplies a Front conversation", async () => {
    const { handler } = await import("../../amplify/functions/communications/handler");
    expect(await handler({ arguments: { readOperation: "context", input: { conversationId: "cnv_a" } } })).toMatchObject({ ok: false, error: expect.stringContaining("Sign in") });
  });
  it("does not let ordinary staff edit eligibility, secrets or replay uncertain sends", async () => {
    const { handler } = await import("../../amplify/functions/communications/handler");
    for (const operation of ["saveEligibility", "saveSettings", "reviewOperation", "activate"]) {
      expect(await handler({ arguments: { operation, input: {} }, identity: { sub: "staff", groups: [] } as never })).toMatchObject({ ok: false, error: expect.stringContaining("Only an admin") });
    }
  });
});
