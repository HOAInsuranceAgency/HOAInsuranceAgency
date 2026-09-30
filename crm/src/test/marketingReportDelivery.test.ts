import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ records: new Map<string, Record<string, unknown>>(), send: vi.fn(), invoke: vi.fn(), ses: vi.fn(), snapshot: vi.fn(), failSentWrite: false }));
vi.mock("@aws-sdk/lib-dynamodb", async original => ({ ...await original<typeof import("@aws-sdk/lib-dynamodb")>(), DynamoDBDocumentClient: { from: () => ({ send: h.send }) } }));
vi.mock("@aws-sdk/client-lambda", async original => ({ ...await original<typeof import("@aws-sdk/client-lambda")>(), LambdaClient: class { send = h.invoke; } }));
vi.mock("@aws-sdk/client-sesv2", async original => ({ ...await original<typeof import("@aws-sdk/client-sesv2")>(), SESv2Client: class { send = h.ses; } }));
vi.mock("../../amplify/functions/marketing-report/snapshot", async original => ({ ...await original<typeof import("../../amplify/functions/marketing-report/snapshot")>(), reportSnapshot: h.snapshot }));
vi.mock("../../../shared/marketingLeadReport", () => ({ buildMarketingLeadReport: () => ({ headers: ["Lead"], rows: [["Test HOA"]], warnings: [], asOf: "2026-09-25T12:00:00Z" }) }));
vi.mock("../../amplify/functions/marketing-report/workbook", () => ({ buildMarketingReportWorkbook: () => new Uint8Array([80, 75]) }));
import { handler as api } from "../../amplify/functions/marketing-report/api";
import { handler as worker, easternScheduleDay } from "../../amplify/functions/marketing-report/worker";
import { readSettings, reserveRun, manualRunId, settingsSnapshot, validEmail, reconcileStale } from "../../amplify/functions/marketing-report/store";
import { scanComplete, linkedCommunications } from "../../amplify/functions/marketing-report/snapshot";
const now = "2026-09-25T12:00:00.000Z", recipient = "reports@example.com", requestId = "98c1aba1-9421-414b-8895-d5919c48ae10";
const admin = { identity: { sub: "administrator", claims: { "cognito:groups": ["ADMIN"] } } };
const sendEvent = () => ({ ...admin, arguments: { operation: "sendNow", input: { requestId } } });
const scheduleEvent = () => ({ trigger: "scheduled", scheduledAt: now, scheduleArn: "arn:aws:scheduler:us-east-1:123:schedule/default/report" });
const manualEvent = () => ({ trigger: "manual", runId: manualRunId(requestId) });
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function conditional() { const error = new Error("Condition failed"); error.name = "ConditionalCheckFailedException"; return error; }
function configure(enabled = false) { h.records.set("marketing-report:settings", { id: "marketing-report:settings", kind: "MARKETING_REPORT_SETTINGS", version: 1, data: { version: 1, enabled, recipient }, createdAt: now, updatedAt: now }); }
function run() { return h.records.get(manualRunId(requestId)) as { id: string; data: { status: string; rowCount?: number; recipient?: string }; version: number }; }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(now)); h.records.clear(); h.invoke.mockReset().mockResolvedValue({ StatusCode: 202 }); h.ses.mockReset().mockResolvedValue({ MessageId: "accepted-message" }); h.snapshot.mockReset().mockResolvedValue({}); h.failSentWrite = false;
  vi.stubEnv("COMMUNICATION_TABLE", "communications"); vi.stubEnv("MARKETING_REPORT_ENV", "main"); vi.stubEnv("MARKETING_REPORT_WORKER", "worker"); vi.stubEnv("MARKETING_REPORT_FROM", "insurance@example.com"); vi.stubEnv("MARKETING_REPORT_SCHEDULE_ARN", scheduleEvent().scheduleArn);
  h.send.mockReset().mockImplementation(async command => {
    const input = command.input;
    if (command.constructor.name === "GetCommand") return { Item: h.records.has(input.Key.id) ? clone(h.records.get(input.Key.id)) : undefined };
    if (command.constructor.name === "QueryCommand") return { Items: [...h.records.values()].filter(record => record.kind === "MARKETING_REPORT_RUN").map(clone) };
    if (command.constructor.name === "TransactWriteCommand") {
      for (const write of input.TransactItems) {
        const operation = write.Put ?? write.ConditionCheck, old = h.records.get(operation.Item?.id ?? operation.Key?.id);
        if (operation.ConditionExpression === "attribute_not_exists(id)" && old || operation.ConditionExpression === "#v = :v" && old?.version !== operation.ExpressionAttributeValues[":v"]) throw conditional();
        if (h.failSentWrite && operation.Item?.data?.status === "sent") throw new Error("Ledger unavailable");
      }
      for (const write of input.TransactItems) if (write.Put) h.records.set(write.Put.Item.id, clone(write.Put.Item));
      return {};
    }
    throw new Error(`Unexpected database call: ${command.constructor.name}`);
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
describe("administrator marketing report controls", () => {
  it("requires the administrator view for a user also assigned the producer role", async () => {
    const identity = { sub: "administrator", groups: ["ADMIN", "PRODUCER"] };
    expect(await api({ identity, request: { headers: { "x-crm-role": "PRODUCER" } }, arguments: {} })).toMatchObject({ ok: false, error: expect.stringContaining("Administrator") });
    expect(h.send).not.toHaveBeenCalled(); expect(h.invoke).not.toHaveBeenCalled();
    expect(await api({ identity, request: { headers: { "x-crm-role": "ADMIN" } }, arguments: {} })).toMatchObject({ ok: true });
  });
  it("returns safe defaults with the real Amplify event shape without info", async () => {
    expect(await api({ ...admin, arguments: {} })).toMatchObject({ ok: true, settings: { version: 0, enabled: false, recipient: "" }, schedule: { day: "Friday", time: "08:00", timeZone: "America/New_York" } }); expect(h.invoke).not.toHaveBeenCalled();
  });
  it.each([undefined, { sub: "user", groups: ["STAFF"] }, { sub: "user", groups: "ADMIN" }, { groups: ["ADMIN"] }])("rejects unauthorized identities before data access", async identity => {
    expect(await api({ identity })).toMatchObject({ ok: false, error: "Administrator access is required." }); expect(h.send).not.toHaveBeenCalled();
  });
  it("validates email headers and rejects multi-recipient input", () => {
    for (const value of ["a@example.com\r\nBcc: bad@example.com", "a@example.com,b@example.com", "Name <a@example.com>", "a@host", "a@-invalid.com"]) expect(() => validEmail(value)).toThrow(); expect(validEmail(" Reports@Example.COM ")).toBe(recipient);
  });
  it("saves with optimistic concurrency and refuses stale settings", async () => {
    const save = () => api({ ...admin, arguments: { operation: "save", input: { version: 0, enabled: true, recipient } } });
    expect(await save()).toMatchObject({ ok: true, settings: { version: 1, enabled: true, recipient } }); expect(await save()).toMatchObject({ ok: false, error: expect.stringContaining("changed") });
  });
  it("keeps nonproduction automatic delivery off and restricts manual recipients", async () => {
    vi.stubEnv("MARKETING_REPORT_ENV", "staging"); configure(); expect(await api(sendEvent())).toMatchObject({ ok: false, error: expect.stringContaining("test recipient") }); h.records.set("config", { id: "config", data: { testRecipients: [recipient] } });
    expect(await api({ ...admin, arguments: { operation: "save", input: { version: 1, recipient, enabled: true } } })).toMatchObject({ ok: false, error: expect.stringContaining("production") }); expect(await api(sendEvent())).toMatchObject({ ok: true, run: { status: "queued" } }); expect(await worker(scheduleEvent())).toEqual({ skipped: true });
  });
  it("queues immediately and deduplicates concurrent requests before SES", async () => {
    configure(); const results = await Promise.all([api(sendEvent()), api(sendEvent())]); expect(results.every(result => result.ok)).toBe(true); expect(h.invoke).toHaveBeenCalledTimes(1); expect(h.ses).not.toHaveBeenCalled(); expect(JSON.parse(Buffer.from(h.invoke.mock.calls[0][0].input.Payload).toString())).toEqual(manualEvent());
  });
  it("records invoke failure before send and does not requeue the same request", async () => {
    configure(); h.invoke.mockRejectedValue(new Error("Timeout")); expect(await api(sendEvent())).toMatchObject({ ok: true, run: { status: "failed", retryable: true } }); await api(sendEvent()); await worker(manualEvent()); expect(h.invoke).toHaveBeenCalledTimes(1); expect(h.ses).not.toHaveBeenCalled();
  });
  it("reserves against the exact settings version", async () => {
    configure(); const settings = (await readSettings())!; h.records.set("marketing-report:settings", { ...h.records.get("marketing-report:settings"), version: 2 }); await expect(reserveRun(manualRunId(requestId), "manual", settings, now, "admin")).rejects.toThrow("Settings changed"); expect(run()).toBeUndefined();
  });
});
describe("weekly worker and durable send ledger", () => {
  it("uses 8 AM Eastern across both DST changes", () => {
    for (const [timestamp, day] of [["2026-03-06T13:00:00Z", "2026-03-06"], ["2026-03-13T12:00:00Z", "2026-03-13"], ["2026-10-30T12:00:00Z", "2026-10-30"], ["2026-11-06T13:00:00Z", "2026-11-06"]]) expect(easternScheduleDay(timestamp)).toBe(day);
    expect(() => easternScheduleDay("2026-11-06T12:00:00Z")).toThrow(); expect(() => easternScheduleDay("2026-09-24T12:00:00Z")).toThrow();
  });
  it("does nothing before explicit configuration", async () => { expect(await worker(scheduleEvent())).toEqual({ skipped: true }); configure(false); await worker(scheduleEvent()); expect(h.ses).not.toHaveBeenCalled(); });
  it("rejects forged schedules and unreserved manual requests", async () => {
    await expect(worker({})).rejects.toThrow("Unrecognized"); await expect(worker({ ...scheduleEvent(), scheduleArn: "forged" })).rejects.toThrow("Unrecognized"); await expect(worker({ ...scheduleEvent(), scheduledAt: "2026-09-18T12:00:00Z" })).rejects.toThrow("expired"); await expect(worker(manualEvent())).rejects.toThrow("reserved"); expect(h.ses).not.toHaveBeenCalled();
  });
  it("sends a reserved manual run once with its recipient snapshot", async () => {
    configure(); await api(sendEvent()); const settings = h.records.get("marketing-report:settings")!; settings.data = { recipient: "changed@example.com", version: 2 }; settings.version = 2;
    await worker(manualEvent()); await worker(manualEvent()); expect(h.ses).toHaveBeenCalledTimes(1); expect(h.ses.mock.calls[0][0].input.Destination).toEqual({ ToAddresses: [recipient] }); expect(run().data).toMatchObject({ status: "sent", rowCount: 1 });
    const raw = Buffer.from(h.ses.mock.calls[0][0].input.Content.Raw.Data).toString(); expect(raw).toContain("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"); expect(raw).toContain("HOA_LEAD_UPDATE_2026-09-25.xlsx");
  });
  it("deduplicates the scheduled Eastern Friday across concurrent worker retries", async () => {
    configure(true); await Promise.all([worker(scheduleEvent()), worker(scheduleEvent())]); await worker(scheduleEvent()); expect(h.ses).toHaveBeenCalledTimes(1); expect(h.records.get("marketing-report:run:scheduled:2026-09-25")).toMatchObject({ data: { status: "sent" } });
  });
  it("never sends partial data or automatically retries a failed run", async () => {
    configure(); await api(sendEvent()); h.snapshot.mockRejectedValue(new Error("One source unavailable")); await expect(worker(manualEvent())).rejects.toThrow("failed"); expect(run().data).toMatchObject({ status: "failed", retryable: true }); await worker(manualEvent()); expect(h.ses).not.toHaveBeenCalled();
  });
  it.each(["SES response lost", "Ledger unavailable after acceptance"])("never resends uncertain delivery: %s", async reason => {
    configure(); await api(sendEvent()); if (reason.startsWith("SES")) h.ses.mockRejectedValue(new Error("Timeout")); else h.failSentWrite = true;
    await expect(worker(manualEvent())).rejects.toThrow("unknown"); expect(run().data).toMatchObject({ status: "unknown", retryable: false }); await worker(manualEvent()); await api(sendEvent()); expect(h.ses).toHaveBeenCalledTimes(1); expect(h.invoke).toHaveBeenCalledTimes(1);
  });
  it("surfaces expired queued jobs and uncertain stopped workers without requeueing", async () => {
    configure(); await api(sendEvent()); vi.advanceTimersByTime(11 * 60_000); expect((await settingsSnapshot()).recentRuns[0]).toMatchObject({ status: "failed", retryable: true }); const record = h.records.get(manualRunId(requestId))!; (record.data as Record<string, unknown>).status = "sending"; (record.data as Record<string, unknown>).updatedAt = now;
    expect((await reconcileStale(record as never)).data).toMatchObject({ status: "unknown", retryable: false }); expect(h.invoke).toHaveBeenCalledTimes(1);
  });
});
describe("complete bounded data reads", () => {
  const budget = () => ({ deadline: Date.now() + 5000, rows: 0, bytes: 0, pages: 0 });
  it("collects the report without reading the unused contact table", async () => {
    const sourceEnvs = ["ACCOUNT_TABLE", "QUOTE_TABLE", "POLICY_TABLE", "PRIOR_CARRIER_TABLE", "CARRIER_TABLE", "DOCUMENT_TABLE", "ACTIVITY_TABLE"];
    for (const env of sourceEnvs) vi.stubEnv(env, env);
    vi.stubEnv("CONTACT_TABLE", undefined);
    h.send.mockReset().mockResolvedValue({ Items: [] });
    const actual = await vi.importActual<typeof import("../../amplify/functions/marketing-report/snapshot")>("../../amplify/functions/marketing-report/snapshot");
    const snapshot = await actual.reportSnapshot();
    expect(h.send.mock.calls.map(([command]) => command.input.TableName)).toEqual([...sourceEnvs, "communications"]);
    expect(snapshot).not.toHaveProperty("contacts");
  });
  it("collects property classification evidence without reading full intake snapshots or secret fields", async () => {
    const sourceEnvs = ["ACCOUNT_TABLE", "QUOTE_TABLE", "POLICY_TABLE", "PRIOR_CARRIER_TABLE", "CARRIER_TABLE", "DOCUMENT_TABLE", "ACTIVITY_TABLE"];
    for (const env of sourceEnvs) vi.stubEnv(env, env);
    h.send.mockReset().mockImplementation(async command => ({ Items: command.input.TableName === "communications" ? [{
      id: "submission:example", kind: "SUBMISSION", data: { accountId: "a", receivedAt: now, snapshot: { propertyKind: "condominium", answers: { "Property type": "condominium" } } },
    }] : [] }));
    const actual = await vi.importActual<typeof import("../../amplify/functions/marketing-report/snapshot")>("../../amplify/functions/marketing-report/snapshot");
    const snapshot = await actual.reportSnapshot();
    expect(snapshot.submissions).toEqual([{ accountId: "a", createdAt: now, propertyKind: "condominium", answerPropertyKind: "condominium" }]);
    const paths = (input: { ProjectionExpression: string; ExpressionAttributeNames: Record<string, string> }) => input.ProjectionExpression.split(", ").map(path => path.split(".").map(key => input.ExpressionAttributeNames[key]).join("."));
    expect(paths(h.send.mock.calls[0][0].input)).toEqual(expect.arrayContaining(["propertyType", "unitCount"]));
    const selected = paths(h.send.mock.calls.at(-1)![0].input);
    expect(selected).toEqual(expect.arrayContaining(["data.accountId", "data.receivedAt", "data.snapshot.propertyKind", "data.snapshot.answers.Property type"]));
    for (const secret of ["data.snapshot", "data.snapshot.answers", "data.proofHash", "data.uploadToken", "data.estimateToken"]) expect(selected).not.toContain(secret);
  });
  it("follows pages even when a filtered page is empty", async () => {
    h.send.mockReset().mockResolvedValueOnce({ Items: [{ id: "one" }], LastEvaluatedKey: { id: "one" } }).mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { id: "two" } }).mockResolvedValueOnce({ Items: [{ id: "three" }] }); expect(await scanComplete({ TableName: "source" }, budget())).toEqual([{ id: "one" }, { id: "three" }]); expect(h.send.mock.calls[2][0].input.ExclusiveStartKey).toEqual({ id: "two" }); expect(h.send.mock.calls[0][0].input.ConsistentRead).toBe(true);
  });
  it("fails closed on page errors, repeated cursors and exhausted budgets", async () => {
    h.send.mockReset().mockResolvedValueOnce({ Items: [{ id: "one" }], LastEvaluatedKey: { id: "one" } }).mockRejectedValueOnce(new Error("Unavailable")); await expect(scanComplete({ TableName: "source" }, budget())).rejects.toThrow("Unavailable"); h.send.mockReset().mockResolvedValue({ Items: [], LastEvaluatedKey: { id: "same" } }); await expect(scanComplete({ TableName: "source" }, budget())).rejects.toThrow("pagination"); await expect(scanComplete({ TableName: "source" }, { ...budget(), pages: 2000 })).rejects.toThrow("collection limit");
  });
  it("requires current prospect links and ignores stale carrier or reassigned conversations", () => {
    const communication = { id: "email", kind: "COMMUNICATION", accountId: "a", data: { accountId: "a", conversationId: "cnv", channel: "EMAIL", purpose: "PROSPECT" } }; expect(linkedCommunications([communication])).toEqual([]); const link = { id: "front-link:cnv", kind: "LINK", data: { accountId: "a", purpose: "PROSPECT" } }; expect(linkedCommunications([communication, link])).toHaveLength(1);
    for (const data of [{ accountId: "b", purpose: "PROSPECT" }, { accountId: "a", purpose: "CARRIER" }, { accountId: "a", purpose: "PROSPECT", context: "RENEWAL" }]) expect(linkedCommunications([communication, { ...link, data }])).toEqual([]);
  });
});
