import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { migrationProbeScopes, PROBE_MODELS, PROBE_KEYS } from "../../amplify/migration-probe-scopes";
const api = "a".repeat(26), timestamp = "2026-10-29T20:00:00.000";
const fixture = () => Object.fromEntries(Object.entries(PROBE_MODELS).map(([worker, models]) => [worker, models.map(model => [`${model}-${api}-NONE`, timestamp, PROBE_KEYS[model] ?? "id"])]));
const receipt = (raw: string) => JSON.stringify({ probeScopeManifestSha256: createHash("sha256").update(raw).digest("hex") });
describe("compact reviewed migration stream scopes", () => {
  it("adds no scope payload to quarantine or non-probing phases", () => expect(new Set(Object.values(migrationProbeScopes(false)))).toEqual(new Set(["[]"])));
  it("binds all 22 mappings across17tables while keeping every envvalue bounded", () => {
    const raw = JSON.stringify(fixture()), scopes = migrationProbeScopes(true, raw, receipt(raw));
    expect(Object.values(scopes).reduce((n, v) => n + JSON.parse(v).length, 0)).toBe(22);
    expect(Object.values(scopes).every(v => Buffer.byteLength(v) <= 2400)).toBe(true);
  });
  it.each(["GlApplication", "DoApplication"])("uses the actual accountId-only key for %s", model => {
    const m: any = fixture(), row = m.activityLog.find((r: string[]) => r[0].startsWith(`${model}-`));
    expect(row[2]).toBe("accountId");
    const raw = JSON.stringify(m); expect(() => migrationProbeScopes(true, raw, receipt(raw))).not.toThrow();
    row[2] = "id"; const wrong = JSON.stringify(m); expect(() => migrationProbeScopes(true, wrong, receipt(wrong))).toThrow();
  });
  it("does not expand accountId permission to other models", () => {
    const m: any = fixture(); m.activityLog[0][2] = "accountId";
    const raw = JSON.stringify(m); expect(() => migrationProbeScopes(true, raw, receipt(raw))).toThrow();
  });
  it.each(["missing", "extra", "duplicate", "foreign", "generation", "schema", "mixed-api", "size"])("rejects %s scope drift even with a matchinghash", kind => {
    const m: any = fixture();
    if (kind === "missing") delete m.communicationWorker;
    if (kind === "extra") m.unrelatedWorker = [];
    if (kind === "duplicate") m.activityLog[1] = m.activityLog[0];
    if (kind === "foreign") m.honeycombWorker[0][0] = `Invoice-${api}-NONE`;
    if (kind === "generation") m.communicationWorker[0][1] = "2026-10-28T20:00:00.000";
    if (kind === "schema") m.activityLog[0][2] = "customerId";
    if (kind === "mixed-api") m.honeycombWorker[0][0] = `HoneycombEstimate-${"b".repeat(26)}-NONE`;
    const raw = JSON.stringify(m) + (kind === "size" ? " ".repeat(5000) : "");
    expect(() => migrationProbeScopes(true, raw, receipt(raw))).toThrow();
  });
  it("rejects missing or mismatched independent receipt", () => {
    const raw = JSON.stringify(fixture());
    expect(() => migrationProbeScopes(true, raw, "{}")).toThrow();
    expect(() => migrationProbeScopes(true, raw, receipt(raw + " "))).toThrow();
  });
});
