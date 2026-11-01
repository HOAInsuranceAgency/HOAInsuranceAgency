import { createHash } from "node:crypto";

export const PROBE_MODELS: Record<string, readonly string[]> = {
  activityLog: ["Account", "Contact", "PriorCarrier", "Building", "Blanket", "GlApplication", "GlClassCode", "DoApplication", "DoCoveragePart", "Loss", "Quote", "Policy", "Certificate", "Document", "Invoice"],
  communicationWorker: ["Account", "Quote", "Policy", "Certificate", "Document"],
  honeycombWorker: ["HoneycombEstimate"],
  honeycombSubmissionWorker: ["HoneycombSubmission"],
};

export const PROBE_KEYS: Readonly<Record<string, "id" | "accountId">> = { GlApplication: "accountId", DoApplication: "accountId" };

/** Literal reviewed stream bindings avoid oversized CFN expressions/Lambda envs. */
export function migrationProbeScopes(enabled: boolean, raw?: string, receiptRaw?: string): Record<string, string> {
  if (!enabled) return Object.fromEntries(Object.keys(PROBE_MODELS).map(worker => [worker, "[]"]));
  if (!raw || Buffer.byteLength(raw) > 5000) throw new Error("Stream probe requires a compact reviewed scope manifest.");
  let manifest: Record<string, unknown>, receipt: { probeScopeManifestSha256?: string };
  try { manifest = JSON.parse(raw); receipt = JSON.parse(receiptRaw ?? ""); } catch { throw new Error("Stream probe scope/prepare receipt is invalid."); }
  if (!manifest || Array.isArray(manifest) || JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(Object.keys(PROBE_MODELS).sort())
    || createHash("sha256").update(raw).digest("hex") !== receipt?.probeScopeManifestSha256) throw new Error("Stream probe scope differs from its reviewed prepare receipt.");
  const result: Record<string, string> = {}; const tableGeneration = new Map<string, string>(); const apiIds = new Set<string>();
  for (const [worker, models] of Object.entries(PROBE_MODELS)) {
    const entries = manifest[worker];
    if (!Array.isArray(entries) || entries.length !== models.length) throw new Error("Stream probe worker table inventory differs.");
    const seen = new Set<string>();
    for (const row of entries) {
      if (!Array.isArray(row) || row.length !== 3 || row.some(v => typeof v !== "string") || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/.test(row[1]) || !Number.isFinite(Date.parse(`${row[1]}Z`))) throw new Error("Stream probe scope row is invalid.");
      const match = /^([A-Za-z]+)-([a-z0-9]{26})-NONE$/.exec(row[0]);
      if (!match || !models.includes(match[1]) || seen.has(match[1]) || row[2] !== (PROBE_KEYS[match[1]] ?? "id")) throw new Error("Stream probe scope has a foreign or duplicated model.");
      if (tableGeneration.has(row[0]) && tableGeneration.get(row[0]) !== row[1]) throw new Error("Shared model has conflicting stream generations.");
      tableGeneration.set(row[0], row[1]); apiIds.add(match[2]); seen.add(match[1]);
    }
    const encoded = JSON.stringify(entries);
    if (Buffer.byteLength(encoded) > 2400) throw new Error("Stream probe scope exceeds its Lambda environment budget.");
    result[worker] = encoded;
  }
  if (apiIds.size !== 1 || tableGeneration.size !== 17) throw new Error("Stream probe tables must belong to one exact API and its 17 distinct models.");
  return result;
}
