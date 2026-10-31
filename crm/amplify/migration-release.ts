/** Execution controls are independent of restoring normal API resolvers. */
export interface MigrationReleaseInput {
  destination: boolean;
  preview: boolean;
  streamPhase: string;
  schedulesEnabled: boolean;
  workersEnabled?: string;
  streamProbeEnabled?: string;
  probeToken?: string;
  probeExpiresAt?: string;
  now?: number;
}

export const MIGRATION_STREAM_WORKERS = new Set([
  "activityLog", "communicationWorker", "honeycombWorker", "honeycombSubmissionWorker",
]);

export function resolveMigrationRelease(input: MigrationReleaseInput) {
  const flag = (value: string | undefined, name: string) => {
    if (value !== undefined && value !== "true" && value !== "false") throw new Error(`Invalid ${name}`);
    return value === "true";
  };
  const workersEnabled = flag(input.workersEnabled, "HOA_MIGRATION_WORKERS_ENABLED");
  const streamProbeEnabled = flag(input.streamProbeEnabled, "HOA_MIGRATION_STREAM_PROBE_ENABLED");
  if (!input.destination) {
    if (workersEnabled || streamProbeEnabled) throw new Error("Migration release controls require the destination backend");
    return { phase: "legacy" as const, holdBusinessExecution: false, workersEnabled: true, streamProbeEnabled: false };
  }
  if (!["quarantine", "armed"].includes(input.streamPhase)) throw new Error("Invalid migration stream phase");
  if (input.preview && (workersEnabled || streamProbeEnabled)) throw new Error("Preview cannot activate migration workers or stream probes");
  if (!input.preview && input.streamPhase !== "armed") throw new Error("Release requires the post-copy stream phase");
  if (workersEnabled && streamProbeEnabled) throw new Error("Stream probes and business execution cannot overlap");
  if (input.schedulesEnabled && !workersEnabled) throw new Error("Schedules require separately enabled business workers");
  if (streamProbeEnabled) {
    if (!/^[a-f0-9]{64}$/.test(input.probeToken ?? "")) throw new Error("Stream probe requires an exact 256-bit marker token");
    const expires = Date.parse(input.probeExpiresAt ?? ""), now = input.now ?? Date.now();
    if (!Number.isFinite(expires) || expires <= now || expires - now > 4 * 3600_000) {
      throw new Error("Stream probe requires an unexpired window of at most four hours");
    }
  }
  return {
    phase: input.preview ? "preview" as const : workersEnabled ? "active" as const : streamProbeEnabled ? "polling" as const : "primed" as const,
    holdBusinessExecution: !workersEnabled,
    workersEnabled,
    streamProbeEnabled,
  };
}
