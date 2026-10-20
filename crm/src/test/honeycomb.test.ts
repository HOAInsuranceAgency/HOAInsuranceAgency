// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createHash, createHmac } from "node:crypto";
const h = vi.hoisted(() => ({ records: new Map<string, any>(), send: vi.fn() }));
vi.mock("@aws-sdk/lib-dynamodb", async original => ({
  ...await original<typeof import("@aws-sdk/lib-dynamodb")>(),
  DynamoDBDocumentClient: { from: () => ({ send: h.send }) },
}));
import { estimate, parseResult, signature, ESTIMATE_PATH } from "../../amplify/functions/honeycomb/client";
import { estimateInput, publicEstimate, type EstimateRecord } from "../../amplify/functions/honeycomb/contract";
import { processEstimate } from "../../amplify/functions/honeycomb/worker";
import { handler as status } from "../../amplify/functions/honeycomb/status";
const input = { type: "ASSOCIATION", propertyKind: "condominium", address: "1 Main St", city: "Juneau", state: "AK", grossSquareFeet: "10000", replacementValue: "2500000", unitCount: "12" };
const payload = () => estimateInput(input)!;
const record = (overrides: Partial<EstimateRecord> = {}): EstimateRecord => ({ id: "id", accountId: "private-account", status: "PENDING", input: JSON.stringify(payload()), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: Math.floor(Date.now()/1000)+900, ...overrides });
beforeEach(() => {
  vi.stubEnv("HONEYCOMB_ENABLED", "true"); vi.stubEnv("HONEYCOMB_API_BASE_URL", "https://staging-api.honeycombinsurance.com");
  vi.stubEnv("HONEYCOMB_ENVIRONMENT", "staging");
  vi.stubEnv("HONEYCOMB_API_USER", "test-user"); vi.stubEnv("HONEYCOMB_PRODUCER_ID", "producer@example.test"); vi.stubEnv("HONEYCOMB_API_SECRET_KEY", "test-secret"); vi.stubEnv("HONEYCOMB_ESTIMATE_TABLE", "estimates");
  h.records.clear(); h.send.mockReset().mockImplementation(async command => {
    const p = command.input, old = h.records.get(p.Key.id);
    if (command.constructor.name === "GetCommand") return { Item: old && { ...old } };
    if (command.constructor.name === "UpdateCommand") {
      if (old?.status !== (p.ExpressionAttributeValues[":pending"] ?? p.ExpressionAttributeValues[":running"])) throw Object.assign(new Error("Conflict"), { name: "ConditionalCheckFailedException" });
      for (const expression of p.UpdateExpression.replace(/^SET /, "").split(", ")) {
        const [key, value] = expression.split(" = "); old[p.ExpressionAttributeNames[key] ?? key] = p.ExpressionAttributeValues[value];
      }
      return {};
    }
    throw new Error("Unexpected command");
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("carrier contract", () => {
  it("accepts all states without filtering the carrier's appetite", () => {
    for (const state of ["AK", "HI", "MA", "CA", "FL", "DC"]) expect(estimateInput({ ...input, state })?.address).toContain(state);
    expect(payload().submissionData).toEqual({ buildingType: "condominium", grossSQFeet: 10000, replacementValue: 2500000, numUnits: 12 });
  });
  it("does not invent missing values or classify an owner / unknown HOA as a condominium", () => {
    for (const patch of [{ grossSquareFeet: "" }, { grossSquareFeet: "499" }, { replacementValue: "NaN" }, { replacementValue: "100000000" }, { address: "" }, { type: "PERSONAL" }, { propertyKind: "other" }, { propertyKind: undefined }]) expect(estimateInput({ ...input, ...patch })).toBeNull();
  });
  it("signs exactly the UTF-8 body sent, with method and path", async () => {
    const value = { ...payload(), address: "1 Élan Lane, Juneau, AK" };
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ isOkToSubmit: true, priceIndication: 1234.56 })));
    await estimate(value, request);
    const [url, opts] = request.mock.calls[0];
    expect(url).toBe(`https://staging-api.honeycombinsurance.com${ESTIMATE_PATH}`);
    expect(opts.body).toBe(JSON.stringify(value));
    expect(opts.headers["x-signature"]).toBe(createHmac("sha256", "test-secret").update("POST" + opts.body + ESTIMATE_PATH).digest("hex"));
    expect(opts.headers).not.toHaveProperty("x-producer-id");
    expect(signature("post", opts.body, ESTIMATE_PATH, "test-secret")).toBe(opts.headers["x-signature"]);
  });
  it("never sends staging credentials to production or a disabled integration", async () => {
    const request = vi.fn();
    vi.stubEnv("HONEYCOMB_API_BASE_URL", "https://api.honeycombinsurance.com");
    expect(await estimate(payload(), request)).toMatchObject({ issue: "CONFIGURATION" });
    vi.stubEnv("HONEYCOMB_API_BASE_URL", "https://staging-api.honeycombinsurance.com"); vi.stubEnv("HONEYCOMB_ENABLED", "false");
    expect(await estimate(payload(), request)).toMatchObject({ issue: "CONFIGURATION" }); expect(request).not.toHaveBeenCalled();
  });
  it("signs production estimates only for the exact production endpoint", async () => {
    vi.stubEnv("HONEYCOMB_ENVIRONMENT", "production");
    vi.stubEnv("HONEYCOMB_API_BASE_URL", "https://api.honeycombinsurance.com");
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ isOkToSubmit: true, priceIndication: 900 })));
    expect(await estimate(payload(), request)).toMatchObject({ status: "READY", price: 900 });
    expect(request.mock.calls[0][0]).toBe(`https://api.honeycombinsurance.com${ESTIMATE_PATH}`);
    expect(request.mock.calls[0][1]).toMatchObject({ redirect: "error", headers: { "User-Agent": "HOAInsuranceAgency-Honeycomb/1.0", "x-user": "test-user" } });
    expect(request.mock.calls[0][1].headers).not.toHaveProperty("x-producer-id");
    for (const endpoint of ["https://staging-api.honeycombinsurance.com", "https://api.honeycombinsurance.com.evil.test", "http://api.honeycombinsurance.com", "https://api.honeycombinsurance.com/"]) {
      request.mockClear(); vi.stubEnv("HONEYCOMB_API_BASE_URL", endpoint);
      expect(await estimate(payload(), request)).toMatchObject({ issue: "CONFIGURATION" });
      expect(request).not.toHaveBeenCalled();
    }
    vi.stubEnv("HONEYCOMB_API_BASE_URL", "https://api.honeycombinsurance.com");
    vi.stubEnv("HONEYCOMB_ENVIRONMENT", "preview");
    expect(await estimate(payload(), request)).toMatchObject({ issue: "CONFIGURATION" });
    expect(request).not.toHaveBeenCalled();
  });
  it("uses default-agency rating without retrying the failing producer override", async () => {
    vi.stubEnv("HONEYCOMB_ENVIRONMENT", "production");
    vi.stubEnv("HONEYCOMB_API_BASE_URL", "https://api.honeycombinsurance.com");
    // Reproduced against production: the producer override fails; default-agency
    // rating returns an ordinary underwriting decision and carrier estimate ID.
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      new Headers(init?.headers).has("x-producer-id")
        ? new Response('{"errorType":"InternalServerException"}', { status: 500 })
        : new Response(JSON.stringify({ isOkToSubmit: false, estimationId: "production-estimate", declinationReasons: ["Outside appetite"] })));
    expect(await estimate(payload(), request)).toMatchObject({ status: "DECLINED", estimationId: "production-estimate" });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("uses isOkToSubmit and requires a positive numeric price", () => {
    expect(parseResult({ isOkToSubmit: false, priceIndication: 1234, declinationReasons: ["Outside territory"] })).toMatchObject({ status: "DECLINED" });
    expect(parseResult({ isOkToSubmit: true, eligibility: "referral", priceIndication: 1234 })).toMatchObject({ status: "READY", price: 1234 });
    for (const priceIndication of [0, -1, null, "1234", undefined, NaN]) expect(parseResult({ isOkToSubmit: true, priceIndication }).status).toBe("UNAVAILABLE");
    expect(parseResult({ eligibility: "open", priceIndication: 1234 }).status).toBe("ERROR");
  });
  it("contains provider failures without retries or leaking the response body", async () => {
    for (const code of [400, 401, 403, 429, 500]) {
      const request = vi.fn().mockResolvedValue(new Response("private provider details", { status: code }));
      expect(await estimate(payload(), request)).toEqual({ status: "ERROR", issue: `HTTP_${code}` }); expect(request).toHaveBeenCalledTimes(1);
    }
    const request = vi.fn().mockRejectedValue(Object.assign(new Error("private URL"), { name: "TimeoutError" }));
    expect(await estimate(payload(), request)).toEqual({ status: "ERROR", issue: "TIMEOUT" });
    expect(await estimate(payload(), vi.fn().mockResolvedValue(new Response("not JSON")))).toMatchObject({ status: "ERROR" });
  });
});
describe("durable worker and public receipt", () => {
  it("allows only one carrier request for concurrent / repeated deliveries", async () => {
    h.records.set("id", record());
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ isOkToSubmit: true, priceIndication: 1234, estimationId: "carrier-id" })));
    vi.stubGlobal("fetch", request);
    await Promise.all([processEstimate("id"), processEstimate("id")]); await processEstimate("id");
    expect(request).toHaveBeenCalledTimes(1); expect(h.records.get("id")).toMatchObject({ status: "READY", price: 1234 });
  });
  it("does not repeat a request interrupted after claim; queue delays still receive an attempt", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ isOkToSubmit: false }))); vi.stubGlobal("fetch", request);
    h.records.set("id", record({ status: "RUNNING", updatedAt: new Date(Date.now()-130000).toISOString() }));
    await processEstimate("id"); expect(h.records.get("id").issue).toBe("INTERRUPTED");
    h.records.set("id", record({ createdAt: new Date(Date.now()-130000).toISOString() }));
    await processEstimate("id"); expect(h.records.get("id").status).toBe("DECLINED"); expect(request).toHaveBeenCalledTimes(1);
  });
  it("requires an unexpired receipt, with identical declines/errors/unknown responses", async () => {
    expect(await status({ arguments: { estimateToken: "private-account" } })).toEqual({ status: "unavailable" }); expect(h.send).not.toHaveBeenCalled();
    const token = "a".repeat(43), id = createHash("sha256").update(token).digest("hex");
    expect(await status({ arguments: { estimateToken: token } })).toEqual({ status: "unavailable" });
    h.records.set(id, record({ status: "READY", price: 1234, result: "private", estimationId: "private" }));
    expect(await status({ arguments: { estimateToken: token } })).toEqual({ status: "ready", price: 1234, currency: "USD", staging: true });
    vi.stubEnv("HONEYCOMB_ENVIRONMENT", "production");
    expect(await status({ arguments: { estimateToken: token } })).toEqual({ status: "ready", price: 1234, currency: "USD", staging: false });
    for (const status of ["DECLINED", "ERROR", "NEEDS_DETAILS", "UNAVAILABLE"]) expect(publicEstimate(record({ status, issue: "secret reason" }))).toEqual({ status: "unavailable" });
    expect(publicEstimate(record({ status: "READY", price: 1234, expiresAt: 1 }))).toEqual({ status: "unavailable" });
    expect(publicEstimate(record({ createdAt: new Date(Date.now()-130000).toISOString() }))).toEqual({ status: "unavailable" });
  });
});
