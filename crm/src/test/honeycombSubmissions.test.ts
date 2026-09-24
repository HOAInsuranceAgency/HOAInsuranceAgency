// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
const h = vi.hoisted(() => ({ records: new Map<string, any>(), send: vi.fn() }));
vi.mock("@aws-sdk/lib-dynamodb", async original => ({ ...await original<typeof import("@aws-sdk/lib-dynamodb")>(), DynamoDBDocumentClient: { from: () => ({ send: h.send }) } }));
import { businessDate, partialInput, eligibleEstimate, submissionStatus, type SourceEstimate, type SubmissionRecord } from "../../amplify/functions/honeycomb/submission-contract";
import { createPartial, partialResult, PARTIAL_PATH } from "../../amplify/functions/honeycomb/submission-client";
import { handler, submissionKey } from "../../amplify/functions/honeycomb/submissions";
import { processSubmission } from "../../amplify/functions/honeycomb/submission-worker";
const now = new Date("2026-09-23T16:00:00Z");
const details = { address: "1 Main St, Juneau, AK", effectiveDate: "2026-10-01", nameInsured: "Test Association", buildingType: "condominium", grossSQFeet: "10,000", replacementValue: "2,500,000" };
const source: SourceEstimate = { id: "estimate", accountId: "account", status: "READY", estimationId: "carrier-estimate", input: JSON.stringify({ address: "2 Original St, Chicago, IL", submissionData: { buildingType: "condominium", grossSQFeet: 15000, replacementValue: 3000000, numUnits: 12 } }), result: JSON.stringify({ isOkToSubmit: true }) };
const createEvent = (extra = {}) => ({ info: { fieldName: "startHoneycombSubmission" }, identity: { sub: "agent" }, arguments: { accountId: "account", details: JSON.stringify(details), reviewed: true, ...extra } });
const readJob = () => h.records.get(`submissions/${submissionKey("account", details.effectiveDate)}`) as SubmissionRecord;
const conflict = () => Object.assign(new Error("Conflict"), { name: "ConditionalCheckFailedException" });
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
  for (const [key, value] of Object.entries({ HONEYCOMB_ENABLED: "true", HONEYCOMB_API_BASE_URL: "https://staging-api.honeycombinsurance.com", HONEYCOMB_API_USER: "test", HONEYCOMB_PRODUCER_ID: "producer", HONEYCOMB_API_SECRET_KEY: "test-secret", HONEYCOMB_SUBMISSION_TABLE: "submissions", HONEYCOMB_ACCOUNT_TABLE: "accounts", HONEYCOMB_ESTIMATE_TABLE: "estimates" })) vi.stubEnv(key, value);
  h.records.clear(); h.records.set("accounts/account", { id: "account", type: "ASSOCIATION", stage: "LEAD" }); h.records.set("estimates/estimate", source);
  h.send.mockReset().mockImplementation(async command => {
    const p = command.input, key = `${p.TableName}/${p.Key?.id ?? p.Item?.id}`, old = h.records.get(key), values = p.ExpressionAttributeValues;
    if (command.constructor.name === "GetCommand") return { Item: old && { ...old } };
    if (command.constructor.name === "TransactWriteCommand") {
      const check = p.TransactItems[0].ConditionCheck, put = p.TransactItems[1].Put, existing = h.records.get(`${put.TableName}/${put.Item.id}`);
      if (h.records.get(`${check.TableName}/${check.Key.id}`)?.type !== "ASSOCIATION") throw conflict();
      if (put.ExpressionAttributeValues ? existing?.status !== "REJECTED" || existing?.updatedAt !== put.ExpressionAttributeValues[":version"] : !!existing) throw conflict();
      h.records.set(`${put.TableName}/${put.Item.id}`, { ...put.Item }); return {};
    }
    if (command.constructor.name === "PutCommand") {
      if (old?.status !== values[":status"] || old?.updatedAt !== values[":version"]) throw conflict();
      h.records.set(key, { ...p.Item }); return {};
    }
    if (command.constructor.name === "UpdateCommand") {
      if (old?.status !== (values[":pending"] ?? values[":running"]) || old?.attempt !== values[":attempt"]) throw conflict();
      for (const expression of p.UpdateExpression.replace(/^SET /, "").split(", ")) { const [name, value] = expression.split(" = "); old[p.ExpressionAttributeNames[name] ?? name] = values[value]; } return {};
    }
    throw new Error("Unexpected command");
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("partial submission contract", () => {
  it("links the carrier estimation ID and exact original rating data", () => {
    expect(partialInput(details, source, now)).toEqual({ address: "2 Original St, Chicago, IL", estimationId: "carrier-estimate", submissionData: { effectiveDate: "2026-10-01", nameInsured: "Test Association", buildingType: "condominium", grossSQFeet: 15000, replacementValue: 3000000, numUnits: 12 } });
  });
  it("omits unknown answers and does not require or invent an estimate", () => {
    expect(partialInput({ address: details.address, nameInsured: "Test", effectiveDate: details.effectiveDate }, undefined, now)).toEqual({ address: details.address, submissionData: { nameInsured: "Test", effectiveDate: details.effectiveDate } });
    expect(partialInput(details, undefined, now).submissionData.grossSQFeet).toBe(10000);
  });
  it("rejects declined, missing, and mismatched estimation data", () => {
    for (const patch of [{ status: "DECLINED" }, { estimationId: "" }, { result: '{"isOkToSubmit":false}' }, { input: "{}" }]) expect(() => partialInput(details, { ...source, ...patch }, now)).toThrow();
    expect(eligibleEstimate({ ...source, status: "UNAVAILABLE" })).toBe(true);
  });
  it("validates dates, ranges, and known condo type without guessing", () => {
    for (const patch of [{ effectiveDate: "2026-02-30" }, { effectiveDate: "2026-09-22" }, { effectiveDate: "2027-01-01" }, { numUnits: "2.5" }, { grossSQFeet: "499" }, { replacementValue: "100000000" }, { buildingType: "other" }, { yearBuilt: "2027" }, { numStories: "21" }]) expect(() => partialInput({ ...details, ...patch }, undefined, now)).toThrow();
    expect(businessDate(new Date("2026-09-24T01:00:00Z"))).toBe("2026-09-23");
  });
  it("recognizes created, duplicate, and declined records with safe portal links", () => {
    const response = { submissionId: "safe-id", submissionStatus: "incomplete", honeycombLink: "https://evil.example" };
    expect(partialResult(200, response)).toMatchObject({ status: "CREATED", portalUrl: "https://staging-falcon.honeycombinsurance.com/quotes/safe-id" });
    expect(partialResult(409, { ...response, code: "DUPLICATE_SUBMISSION_FOUND" }).status).toBe("EXISTING");
    expect(partialResult(200, { ...response, submissionStatus: "declined", declinationReasons: ["State not supported"] })).toMatchObject({ status: "CREATED", submissionStatus: "declined" });
    for (const [code, payload] of [[200, {}], [409, { code: "DUPLICATE_SUBMISSION_FOUND" }], [500, {}], [200, { ...response, submissionId: "../evil" }]] as const) expect(partialResult(code, payload).status).toBe("UNKNOWN");
    for (const code of [400, 401, 403, 422]) expect(partialResult(code, { message: "Rejected" }).status).toBe("REJECTED");
  });
  it("signs the exact transmitted body and never retries ambiguous failures", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ submissionId: "one", submissionStatus: "incomplete" })));
    await createPartial(partialInput({ ...details, nameInsured: "Élan HOA" }, undefined, now), request);
    const [url, init] = request.mock.calls[0]; expect(url).toBe(`https://staging-api.honeycombinsurance.com${PARTIAL_PATH}`);
    expect(init.headers["x-signature"]).toBe(createHmac("sha256", "test-secret").update("POST" + init.body + PARTIAL_PATH).digest("hex")); expect(init.redirect).toBe("error");
    request.mockReset().mockRejectedValue(Object.assign(new Error("private details"), { name: "TimeoutError" }));
    expect(await createPartial(partialInput(details, undefined, now), request)).toEqual({ status: "UNKNOWN", issue: "TIMEOUT" }); expect(request).toHaveBeenCalledTimes(1);
    vi.stubEnv("HONEYCOMB_API_BASE_URL", "https://api.honeycombinsurance.com"); request.mockClear(); expect((await createPartial(partialInput(details, undefined, now), request)).issue).toBe("CONFIGURATION"); expect(request).not.toHaveBeenCalled();
  });
});
describe("agent workflow and durable job", () => {
  it("requires authentication, staging, review, association, and ownership of linked estimate", async () => {
    expect(await handler({ ...createEvent(), identity: undefined })).toMatchObject({ ok: false });
    vi.stubEnv("HONEYCOMB_ENABLED", "false"); expect(await handler(createEvent())).toMatchObject({ ok: false }); vi.stubEnv("HONEYCOMB_ENABLED", "true");
    expect(await handler(createEvent({ reviewed: false }))).toMatchObject({ ok: false });
    h.records.set("estimates/estimate", { ...source, accountId: "someone-else" }); expect(await handler(createEvent({ sourceEstimateId: "estimate" }))).toMatchObject({ ok: false });
    h.records.set("accounts/account", { id: "account", type: "PERSONAL" }); expect(await handler(createEvent())).toMatchObject({ ok: false }); expect(readJob()).toBeUndefined();
  });
  it("queues once for concurrent clicks and retains the Lead and estimate on conversion", async () => {
    const [a, b] = await Promise.all([handler(createEvent({ sourceEstimateId: "estimate" })), handler(createEvent({ sourceEstimateId: "estimate" }))]); expect(a).toEqual(b);
    expect(readJob()).toMatchObject({ status: "PENDING", sourceEstimateId: "estimate", estimationId: "carrier-estimate", attempt: 1, requestedBy: "agent" });
    expect(JSON.parse(readJob().input).estimationId).toBe("carrier-estimate"); expect(h.records.get("accounts/account").stage).toBe("LEAD");
    h.records.get("accounts/account").stage = "CLIENT"; expect(await handler(createEvent())).toEqual(a); expect(readJob().attempt).toBe(1);
  });
  it("makes one carrier call despite concurrent or repeated deliveries", async () => {
    await handler(createEvent()); const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ submissionId: "created", submissionStatus: "incomplete" }))); vi.stubGlobal("fetch", request);
    await Promise.all([processSubmission(readJob().id), processSubmission(readJob().id)]); await processSubmission(readJob().id);
    expect(request).toHaveBeenCalledTimes(1); expect(readJob()).toMatchObject({ status: "CREATED", submissionId: "created" });
  });
  it("requires an explicit versioned retry after rejection and keeps earlier attempts", async () => {
    await handler(createEvent()); Object.assign(readJob(), { status: "REJECTED", issue: "HTTP_400" });
    await handler(createEvent()); expect(readJob().attempt).toBe(1);
    const version = readJob().updatedAt; vi.setSystemTime(new Date(now.getTime()+1000));
    await Promise.all([handler(createEvent({ retryVersion: version })), handler(createEvent({ retryVersion: version }))]);
    expect(readJob().attempt).toBe(2); expect(JSON.parse(readJob().history!)[0].issue).toBe("HTTP_400");
    await handler(createEvent({ retryVersion: version })); expect(readJob().attempt).toBe(2);
  });
  it("does not resend after worker interruption and requires documented portal review", async () => {
    await handler(createEvent()); Object.assign(readJob(), { status: "RUNNING", updatedAt: new Date(now.getTime()-130000).toISOString() });
    const request = vi.fn(); vi.stubGlobal("fetch", request); await processSubmission(readJob().id); expect(readJob().status).toBe("UNKNOWN");
    await handler(createEvent({ retryVersion: readJob().updatedAt })); expect(readJob().attempt).toBe(1); expect(request).not.toHaveBeenCalled();
    const review = { info: { fieldName: "resolveHoneycombSubmission" }, identity: { sub: "agent" }, arguments: { id: readJob().id, outcome: "NOT_CREATED", reviewed: true, note: "Confirmed absent with Honeycomb" } };
    expect(await handler({ ...review, arguments: { ...review.arguments, reviewed: false } })).toMatchObject({ ok: false });
    await handler(review); expect(readJob()).toMatchObject({ status: "REJECTED", resolvedBy: "agent", issue: "CONFIRMED_NOT_CREATED" });
    await handler(createEvent({ retryVersion: readJob().updatedAt })); expect(readJob().attempt).toBe(2);
  });
  it("can link an existing carrier record after a timeout without sending it again", async () => {
    await handler(createEvent()); Object.assign(readJob(), { status: "UNKNOWN" });
    await handler({ info: { fieldName: "resolveHoneycombSubmission" }, identity: { sub: "agent" }, arguments: { id: readJob().id, outcome: "LINK_EXISTING", submissionId: "found", reviewed: true, note: "Found in portal" } });
    expect(readJob()).toMatchObject({ status: "EXISTING", submissionId: "found", portalUrl: "https://staging-falcon.honeycombinsurance.com/quotes/found" });
    expect(submissionStatus({ status: "RUNNING", updatedAt: new Date(now.getTime()-130000).toISOString() })).toBe("UNKNOWN");
  });
});
