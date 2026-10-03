import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamEligibility } from "../../../shared/leadWorkflow";
const h = vi.hoisted(() => ({ fetch: vi.fn(), authorizationFailed: vi.fn(async () => 60), globalAuthDelay: 0, frontSender: "sales@protectmyhoa.com" }));
vi.mock("../../amplify/functions/communications/budget", () => ({
  authorizationDelay: async () => h.globalAuthDelay,
  authorizationFailed: h.authorizationFailed, authorizationRestored: async () => {}, remainingDelay: async () => 0, rememberBudget: async () => {},
}));
vi.mock("../../amplify/functions/communications/config", () => ({
  credentials: async () => ({ frontToken: "test-token" }), config: async () => ({ frontSender: h.frontSender }),
}));
import { resolveProducerEmail, ProducerEmailSetupError } from "../../amplify/functions/communications/producerEmail";
import { frontPersonalResource, providerRequest, FrontPersonalAccessError, ProviderError } from "../../amplify/functions/communications/providers";

const member: TeamEligibility = { userId: "jake", name: "Jake Greasley", email: "login@unrelated.example", enabled: true, salesperson: true, frontId: "tea_jake" };
const channel = (patch: Record<string, unknown> = {}) => ({ id: "cha_jake", type: "smtp", address: "jake@protectmyhoa.com", is_valid: true, is_private: true,
  _links: { related: { owner: "https://hoa.api.frontapp.com/teammates/tea_jake" } }, ...patch });
const signature = (patch: Record<string, unknown> = {}) => ({ id: "sig_jake", body: "<div>Jake Greasley</div>", is_default: true, is_private: true, channel_ids: null,
  _links: { related: { owner: "https://api2.frontapp.com/teammates/tea_jake" } }, ...patch });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function responses(channels = [channel()], signatures = [signature()]) {
  h.fetch.mockImplementation(async (url: URL) => json({ _results: url.pathname.endsWith("/channels") ? channels : signatures }));
}
beforeEach(() => { vi.clearAllMocks(); h.fetch.mockReset(); h.globalAuthDelay = 0; h.frontSender = "sales@protectmyhoa.com"; vi.stubGlobal("fetch", h.fetch); responses(); });
afterEach(() => vi.unstubAllGlobals());

describe("assigned salesperson's Front email identity", () => {
  it("uses the actual mailbox and owned signature rather than the CRM login email", async () => {
    await expect(resolveProducerEmail(member)).resolves.toEqual({ frontId: "tea_jake", channelId: "cha_jake", senderEmail: "jake@protectmyhoa.com", signatureId: "sig_jake", signatureMode: "FRONT" });
    expect(h.fetch.mock.calls.map(([url]) => url.pathname)).toEqual(["/teammates/tea_jake/channels", "/teammates/tea_jake/signatures"]);
    expect(h.fetch.mock.calls.every(([, request]) => request.method === "GET")).toBe(true);
  });
  it("prefers Front's verified send-as address", async () => {
    responses([channel({ send_as: "JAKE@protectmyhoa.com", address: "underlying@other.example" })]);
    await expect(resolveProducerEmail(member)).resolves.toMatchObject({ senderEmail: "jake@protectmyhoa.com" });
  });
  it("selects the unique agency-domain mailbox when the teammate has several mailboxes", async () => {
    responses([channel({ id: "cha_other", address: "jake@other.example" }), channel()]);
    await expect(resolveProducerEmail(member)).resolves.toMatchObject({ channelId: "cha_jake" });
  });
  it("selects explicit owned channel and signature when discovery is ambiguous", async () => {
    responses([channel(), channel({ id: "cha_other", address: "other@protectmyhoa.com" })], [signature(), signature({ id: "sig_other" })]);
    await expect(resolveProducerEmail({ ...member, frontChannelId: "cha_other", frontSignatureId: "sig_other" })).resolves.toMatchObject({ channelId: "cha_other", senderEmail: "other@protectmyhoa.com", signatureId: "sig_other" });
  });
  it.each([
    ["missing", undefined], ["alias", "alt:email:jake@protectmyhoa.com"], ["path", "tea_jake/signatures"],
  ])("requires an exact Front teammate ID: %s", async (_label, frontId) => {
    await expect(resolveProducerEmail({ ...member, frontId })).rejects.toThrow("Team connections");
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it.each([
    { frontChannelId: "cha_bad?id=anything" }, { frontSignatureId: "sig_bad/signature" },
  ])("rejects malformed configured resource IDs before lookup: %j", async patch => {
    await expect(resolveProducerEmail({ ...member, ...patch })).rejects.toThrow("Team connections"); expect(h.fetch).not.toHaveBeenCalled();
  });
  it.each([
    { is_valid: false }, { is_valid: undefined }, { is_private: false }, { type: "front_chat" }, { id: "cha_bad/path" },
    { address: "Jake <jake@protectmyhoa.com>" }, { address: "jake@protectmyhoa.com\r\nBcc: someone@example.com" }, { send_as: "not-an-email" },
    { _links: { related: { owner: "https://api2.frontapp.com/teammates/tea_brian" } } },
    { _links: { related: { owner: "https://api2.frontapp.com/teams/tim_hoa" } } },
    { _links: { related: { owner: "https://attacker.example/teammates/tea_jake" } } },
    { _links: {} },
  ])("holds invalid, disconnected, or unowned personal channels: %j", async patch => {
    responses([channel(patch)]);
    await expect(resolveProducerEmail({ ...member, frontChannelId: "cha_jake" })).rejects.toThrow("personal mailbox owned");
  });
  it("holds missing channels and ambiguous channels instead of falling back to shared sales", async () => {
    responses([]); await expect(resolveProducerEmail(member)).rejects.toThrow("Connect a valid personal email mailbox");
    responses([channel(), channel({ id: "cha_second", address: "second@protectmyhoa.com" })]);
    await expect(resolveProducerEmail(member)).rejects.toThrow("more than one personal mailbox");
  });
  it("keeps missing or disconnected mailbox setup retryable without a global authorization failure", async () => {
    responses([channel({ is_valid: false })]);
    await expect(resolveProducerEmail(member)).rejects.toBeInstanceOf(ProducerEmailSetupError);
    await expect(resolveProducerEmail(member)).rejects.toBeInstanceOf(ProviderError);
    await expect(resolveProducerEmail(member)).rejects.toMatchObject({ status: 0, uncertain: false, retryAfter: 60 });
    expect(h.authorizationFailed).not.toHaveBeenCalled();
  });
  it("never substitutes a discovered channel for a stale explicit mapping", async () => {
    await expect(resolveProducerEmail({ ...member, frontChannelId: "cha_stale" })).rejects.toThrow("selected Front email channel");
  });
  it("selects an applicable unique default or the only applicable signature", async () => {
    responses([channel()], [signature({ id: "sig_other", is_default: false }), signature()]);
    await expect(resolveProducerEmail(member)).resolves.toMatchObject({ signatureId: "sig_jake" });
    responses([channel()], [signature({ is_default: false, channel_ids: ["cha_jake"] }), signature({ id: "sig_other", channel_ids: ["cha_other"] })]);
    await expect(resolveProducerEmail(member)).resolves.toMatchObject({ signatureId: "sig_jake" });
  });
  it("accepts an image signature", async () => {
    responses([channel()], [signature({ body: '<div><img src="https://signature.example/jake.png"></div>' })]);
    await expect(resolveProducerEmail(member)).resolves.toMatchObject({ signatureId: "sig_jake" });
  });
  it.each([
    { body: "   " }, { body: undefined }, { body: "<div><br>&nbsp;</div>" }, { body: "<!-- signature -->" },
    { channel_ids: [] }, { channel_ids: ["cha_other"] }, { channel_ids: undefined }, { is_private: false },
    { _links: { related: { owner: "https://api2.frontapp.com/teammates/tea_brian" } } },
    { _links: { related: { owner: "https://api2.frontapp.com/teams/tim_hoa" } } },
  ])("holds empty, inapplicable, or unowned signatures: %j", async patch => {
    responses([channel()], [signature(patch)]);
    await expect(resolveProducerEmail({ ...member, frontSignatureId: "sig_jake" })).rejects.toThrow("applicable personal signature owned");
  });
  it.each([true, false])("holds multiple signatures when defaults are ambiguous: %s", async is_default => {
    responses([channel()], [signature({ is_default }), signature({ id: "sig_other", is_default })]);
    await expect(resolveProducerEmail(member)).rejects.toThrow("more than one is available");
  });
  it("holds a missing or stale signature instead of using an agency footer", async () => {
    responses([channel()], []); await expect(resolveProducerEmail(member)).rejects.toThrow("Add a personal Front email signature");
    responses(); await expect(resolveProducerEmail({ ...member, frontSignatureId: "sig_stale" })).rejects.toThrow("selected Front signature");
  });
});

describe("complete, scoped Front identity lookup", () => {
  it("follows signature pagination before choosing a default", async () => {
    h.fetch.mockResolvedValueOnce(json({ _results: [channel()] }))
      .mockResolvedValueOnce(json({ _results: [signature({ id: "sig_other", is_default: false })], _pagination: { next: "https://hoa.api.frontapp.com/teammates/tea_jake/signatures?page_token=next" } }))
      .mockResolvedValueOnce(json({ _results: [signature()], _pagination: { next: null } }));
    await expect(resolveProducerEmail(member)).resolves.toMatchObject({ signatureId: "sig_jake" });
    expect(String(h.fetch.mock.calls[2][0])).toBe("https://api2.frontapp.com/teammates/tea_jake/signatures?page_token=next");
  });
  it("finds ambiguous channels on later pages", async () => {
    h.fetch.mockResolvedValueOnce(json({ _results: [channel()], _pagination: { next: "/teammates/tea_jake/channels?page_token=next" } }))
      .mockResolvedValueOnce(json({ _results: [channel({ id: "cha_other", address: "other@protectmyhoa.com" })] }));
    await expect(resolveProducerEmail(member)).rejects.toThrow("more than one personal mailbox");
  });
  it.each([
    "/teammates/tea_brian/channels?page_token=next", "/channels?page_token=next", "https://attacker.example/teammates/tea_jake/channels?page_token=next",
    "/teammates/tea_jake/channels", 123, "",
  ])("rejects changed scope, untrusted origins, cycles, and malformed cursors: %s", async next => {
    h.fetch.mockResolvedValueOnce(json({ _results: [channel()], _pagination: { next } }));
    await expect(resolveProducerEmail(member)).rejects.toThrow(); expect(h.fetch).toHaveBeenCalledTimes(1);
  });
  it("holds rather than deciding from an incomplete oversized listing", async () => {
    h.fetch.mockImplementation(async (url: URL) => {
      const page = Number(url.searchParams.get("page") ?? 0);
      return json({ _results: [channel({ id: `cha_${page}` })], _pagination: { next: `/teammates/tea_jake/channels?page=${page + 1}` } });
    });
    await expect(resolveProducerEmail(member)).rejects.toThrow("pagination could not be completed"); expect(h.fetch).toHaveBeenCalledTimes(20);
  });
  it.each([{ unexpected: [] }, { _results: null }, { _results: [null] }, { _results: [channel(), channel()] }])("holds malformed or duplicate result sets: %j", async page => {
    h.fetch.mockResolvedValueOnce(json(page)); await expect(resolveProducerEmail(member)).rejects.toThrow("response could not be verified");
  });
  it.each(["channels", "signatures"])("keeps %s permission failure separate from global Front authorization", async resource => {
    h.fetch.mockImplementation(async (url: URL) => url.pathname.endsWith(`/${resource}`) ? json({}, 403) : json({ _results: [channel()] }));
    await expect(resolveProducerEmail(member)).rejects.toThrow("Front access to the salesperson's personal mailbox/signature needs setup");
    await expect(resolveProducerEmail(member)).rejects.toBeInstanceOf(FrontPersonalAccessError);
    await expect(resolveProducerEmail(member)).rejects.toMatchObject({ status: 0, uncertain: false, retryAfter: 60 });
    expect(h.authorizationFailed).not.toHaveBeenCalled();
    h.fetch.mockResolvedValue(json({ id: "inb_sales" }));
    await expect(providerRequest("front", "/inboxes/inb_sales")).resolves.toEqual({ id: "inb_sales" });
  });
  it("retains token-wide cooldown for actual authentication failure", async () => {
    h.fetch.mockResolvedValue(json({}, 401));
    await expect(resolveProducerEmail(member)).rejects.toMatchObject({ status: 401 });
    expect(h.authorizationFailed).toHaveBeenCalledWith("front", expect.any(String));
  });
  it("retains the global authorization guard and does not bypass repair cooldown", async () => {
    h.globalAuthDelay = 90;
    await expect(resolveProducerEmail(member)).rejects.toMatchObject({ status: 401, retryAfter: 90 }); expect(h.fetch).not.toHaveBeenCalled();
  });
  it("does not make the personal read helper available for other endpoints", async () => {
    for (const path of ["/conversations/cnv_any/messages", "/channels/cha_any", "http://api2.frontapp.com/teammates/tea_jake/channels"]) {
      expect(() => frontPersonalResource(path)).toThrow("Untrusted");
    }
    expect(h.fetch).not.toHaveBeenCalled();
  });
});
