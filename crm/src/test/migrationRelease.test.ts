import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMigrationRelease } from "../../amplify/migration-release";
import { holdMigrationStream } from "../../amplify/functions/migration-stream-hold";

const token = "a".repeat(64), table = "arn:aws:dynamodb:us-east-1:917680434255:table/Account-reviewed-NONE";
const stream = `${table}/stream/2026-10-30T18:00:00.000`;
const marker = `hoa-migration-probe:${token}`;
const image = (key = "id") => ({ [key]: { S: marker }, _hoaMigrationStreamProbe: { S: token } });
const record = (eventName = "INSERT", key = "id") => ({
  eventSource: "aws:dynamodb", eventSourceARN: stream, eventID: `owned-${eventName}`, eventName,
  dynamodb: { SequenceNumber: "123456789", ApproximateCreationDateTime: Date.now() / 1000, Keys: { [key]: { S: marker } },
    ...(eventName === "INSERT" ? { NewImage: image(key) } : { OldImage: image(key) }) },
});
const event = (...records: unknown[]) => ({ Records: records });
function probe() {
  vi.stubEnv("HOA_MIGRATION_APP_ID", "d1nuh9rw1hcuxo");
  vi.stubEnv("HOA_MIGRATION_PREVIEW", "false");
  vi.stubEnv("HOA_MIGRATION_WORKERS_ENABLED", "false");
  vi.stubEnv("HOA_MIGRATION_STREAM_PROBE_ENABLED", "true");
  vi.stubEnv("HOA_MIGRATION_STREAM_PROBE_TOKEN", token);
  vi.stubEnv("HOA_MIGRATION_STREAM_PROBE_EXPIRES_AT", new Date(Date.now() + 3600_000).toISOString());
  vi.stubEnv("HOA_MIGRATION_STREAM_PROBE_SCOPES", JSON.stringify([["Account-reviewed-NONE", "2026-10-30T18:00:00.000", "id"]]));
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
}
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("separate migration API and worker release", () => {
  const base = { destination: true, preview: false, streamPhase: "armed", schedulesEnabled: false };
  it("defaults destination APIs to held workers, not active business execution", () => {
    expect(resolveMigrationRelease(base)).toMatchObject({ phase: "primed", holdBusinessExecution: true, workersEnabled: false });
  });
  it("keeps source behavior without activating migration flags", () => {
    expect(resolveMigrationRelease({ ...base, destination: false })).toMatchObject({ phase: "legacy", holdBusinessExecution: false });
    expect(() => resolveMigrationRelease({ ...base, destination: false, workersEnabled: "true" })).toThrow("destination");
  });
  it("requires a separate explicit worker activation and refuses early schedules", () => {
    expect(resolveMigrationRelease({ ...base, workersEnabled: "true", schedulesEnabled: true })).toMatchObject({ phase: "active" });
    expect(() => resolveMigrationRelease({ ...base, schedulesEnabled: true })).toThrow("Schedules");
  });
  it("rejects preview activation, absent stream barrier, and malformed booleans", () => {
    expect(() => resolveMigrationRelease({ ...base, preview: true, workersEnabled: "true" })).toThrow("Preview");
    expect(() => resolveMigrationRelease({ ...base, streamPhase: "quarantine" })).toThrow("post-copy");
    expect(() => resolveMigrationRelease({ ...base, workersEnabled: "yes" })).toThrow("Invalid");
  });
  it("only permits bounded probes without business workers", () => {
    const config = { ...base, streamProbeEnabled: "true", probeToken: token, probeExpiresAt: new Date(Date.now() + 3600_000).toISOString() };
    expect(resolveMigrationRelease(config)).toMatchObject({ phase: "polling", holdBusinessExecution: true });
    expect(() => resolveMigrationRelease({ ...config, workersEnabled: "true" })).toThrow("overlap");
    expect(() => resolveMigrationRelease({ ...config, probeToken: "guess" })).toThrow("256-bit");
    expect(() => resolveMigrationRelease({ ...config, probeExpiresAt: new Date(0).toISOString() })).toThrow("window");
    expect(() => resolveMigrationRelease({ ...config, probeExpiresAt: new Date(Date.now() + 5 * 3600_000).toISOString() })).toThrow("window");
  });
});

describe("migration stream probes fail closed before business handlers", () => {
  it("preserves source execution but refuses foreign migration bindings", () => {
    expect(holdMigrationStream(event(record()), "activityLog")).toBe(false);
    vi.stubEnv("HOA_MIGRATION_WORKERS_ENABLED", "false");
    expect(() => holdMigrationStream(event(record()), "activityLog")).toThrow("foreign");
  });
  it("holds destination work when flags are missing", () => {
    vi.stubEnv("HOA_MIGRATION_APP_ID", "d1nuh9rw1hcuxo");
    expect(() => holdMigrationStream(event(record()), "activityLog")).toThrow("held");
  });
  it.each(["activityLog", "communicationWorker", "honeycombWorker", "honeycombSubmissionWorker"])("acknowledges only exact owned INSERT/REMOVE for %s", worker => {
    probe();
    expect(holdMigrationStream(event(record(), record("REMOVE")), worker)).toBe(true);
    expect(console.info).toHaveBeenCalledTimes(2);
    const proof = JSON.parse(vi.mocked(console.info).mock.calls[0][1]);
    expect(proof).toMatchObject({ worker, eventName: "INSERT", streamArn: stream, sequenceNumber: "123456789" });
    expect(proof).not.toHaveProperty("NewImage");
  });
  it("supports actual accountId-only keys without treating them as business data", () => {
    probe(); vi.stubEnv("HOA_MIGRATION_STREAM_PROBE_SCOPES", JSON.stringify([["Account-reviewed-NONE", "2026-10-30T18:00:00.000", "accountId"]]));
    expect(holdMigrationStream(event(record("INSERT", "accountId")), "activityLog")).toBe(true);
  });
  it("can prove an exact cleanup REMOVE on NEW_IMAGE-only streams", () => {
    probe(); const removal = record("REMOVE"); delete (removal.dynamodb as { OldImage?: unknown }).OldImage;
    expect(holdMigrationStream(event(removal), "honeycombWorker")).toBe(true);
  });
  it("rejects mixed batches atomically without emitting partial success", () => {
    probe(); const unexpected = record(); unexpected.dynamodb.Keys.id.S = "real-customer-row";
    expect(() => holdMigrationStream(event(record(), unexpected), "activityLog")).toThrow("retained");
    expect(console.info).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("HOA_MIGRATION_STREAM_HOLD_REJECTED", expect.any(String));
  });
  it("rejects unknown accounts, tables, event types and worker names", () => {
    probe();
    expect(() => holdMigrationStream(event({ ...record(), eventSourceARN: stream.replace("917680434255", "637423611040") }), "activityLog")).toThrow("retained");
    expect(() => holdMigrationStream(event({ ...record(), eventSourceARN: stream.replace("Account-reviewed", "Other-reviewed") }), "activityLog")).toThrow("retained");
    expect(() => holdMigrationStream(event({ ...record(), eventSourceARN: stream.replace("18:00", "18:01") }), "activityLog")).toThrow("retained");
    expect(() => holdMigrationStream(event(record("MODIFY")), "activityLog")).toThrow("retained");
    expect(() => holdMigrationStream(event(record()), "unknownWorker")).toThrow("held");
  });
  it("rejects extra fields, wrong scalar types and compound keys", () => {
    probe(); const extra = record(); ((extra.dynamodb as { NewImage: Record<string, unknown> }).NewImage).customer = { S: "unexpected" };
    expect(() => holdMigrationStream(event(extra), "activityLog")).toThrow("retained");
    const wrong = record(); (wrong.dynamodb.Keys as Record<string, unknown>).id = { N: marker };
    expect(() => holdMigrationStream(event(wrong), "activityLog")).toThrow("retained");
    const compound = record(); (compound.dynamodb.Keys as Record<string, unknown>).sortKey = { S: "anything" };
    expect(() => holdMigrationStream(event(compound), "activityLog")).toThrow("retained");
  });
  it("rejects non-stream scheduled calls while the communication worker can poll", () => {
    probe();
    expect(() => holdMigrationStream(undefined, "communicationWorker")).toThrow("Scheduled");
    expect(() => holdMigrationStream({ source: "aws.events" }, "communicationWorker")).toThrow("Scheduled");
  });
  it("expires closed and rejects a missing or unsafe allowlist", () => {
    probe(); vi.stubEnv("HOA_MIGRATION_STREAM_PROBE_EXPIRES_AT", new Date(Date.now() - 1).toISOString());
    expect(() => holdMigrationStream(event(record()), "activityLog")).toThrow("expired");
    vi.stubEnv("HOA_MIGRATION_STREAM_PROBE_EXPIRES_AT", new Date(Date.now() + 3600_000).toISOString());
    vi.stubEnv("HOA_MIGRATION_STREAM_PROBE_SCOPES", "[]");
    expect(() => holdMigrationStream(event(record()), "activityLog")).toThrow("scope");
  });
  it("passes real records to normal code only after explicit business activation", () => {
    probe(); vi.stubEnv("HOA_MIGRATION_WORKERS_ENABLED", "true");
    expect(() => holdMigrationStream(event(record()), "activityLog")).toThrow("overlapping");
    vi.stubEnv("HOA_MIGRATION_STREAM_PROBE_ENABLED", "false");
    expect(holdMigrationStream(event({ real: "business record" }), "activityLog")).toBe(false);
  });
});
