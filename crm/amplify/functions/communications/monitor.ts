import { get, issue, row, save } from "./store";
import { config } from "./config";
import { resolveIssue } from "./routing";
import { captureHandledFailure, communicationHealthSentryTarget, markRepeatedCommunicationHealthError } from "../monitoring";

const HEALTH_MESSAGE = "Communication processing has stopped. Incoming work may be missing.";
const REASONS = ["missing", "stale", "lagging"] as const;
type HealthReason = typeof REASONS[number];
type SentryHealthState = { version: 1; target: string; reasons: HealthReason[]; lastForwardedAt: string | null };
const REMINDER_MS = 60 * 60_000;

function timestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : undefined;
}

/** Invalid, legacy or contradictory metadata never authorizes suppression. */
function previousState(data: Record<string, unknown> | undefined, target: string, now: number): SentryHealthState | undefined {
  const value = data?.sentryHealth;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const state = value as Partial<SentryHealthState>;
  if (Object.keys(state).sort().join(",") !== "lastForwardedAt,reasons,target,version"
    || state.version !== 1 || state.target !== target || !Array.isArray(state.reasons)
    || state.reasons.some((reason, index, all) => !REASONS.includes(reason) || index > 0 && REASONS.indexOf(reason) <= REASONS.indexOf(all[index - 1]))
    || state.reasons.includes("missing") && state.reasons.length !== 1) return undefined;
  const at = timestamp(data?.at);
  if (at === undefined || at > now || !Array.isArray(data?.errors)
    || (state.reasons.length === 0 ? data.errors.length !== 0 : data.errors.length !== 1 || data.errors[0] !== HEALTH_MESSAGE)) return undefined;
  if (state.reasons.length === 0) return state.lastForwardedAt === null ? state as SentryHealthState : undefined;
  const forwarded = timestamp(state.lastForwardedAt);
  return forwarded !== undefined && forwarded <= at ? state as SentryHealthState : undefined;
}

function reportingState(data: Record<string, unknown> | undefined, target: string, reasons: HealthReason[], at: string, forceForward: boolean) {
  const now = timestamp(at)!;
  if (reasons.length === 0) return { duplicate: false, state: { version: 1, target, reasons, lastForwardedAt: null } satisfies SentryHealthState };
  const previous = previousState(data, target, now);
  const duplicate = !forceForward && previous !== undefined && previous.reasons.join(",") === reasons.join(",")
    && previous.lastForwardedAt !== null && now - timestamp(previous.lastForwardedAt)! < REMINDER_MS;
  return { duplicate, state: { version: 1, target, reasons, lastForwardedAt: duplicate ? previous!.lastForwardedAt : at } satisfies SentryHealthState };
}

function reportStateFailure(error: unknown) {
  // Observability must not replace the original health failure even if its own
  // reporting fails. The normal wrapper still captures that original Error.
  try { captureHandledFailure(error); } catch { /* Keep the health Error. */ }
}

/** Runs independently of the delivery worker, including when that worker stops. */
export const handler = async () => {
  const c = await config(); if (!c.activatedAt) return;
  const now = new Date(), worker = await get("health:worker");
  const reasons: HealthReason[] = [];
  if (!worker) reasons.push("missing");
  else {
    // Preserve the existing health decision and its strict five-minute edge.
    if (now.getTime() - Date.parse(String(worker.data.at)) > 300_000) reasons.push("stale");
    if (worker.data.lagging) reasons.push("lagging");
  }
  const errors = reasons.length ? [HEALTH_MESSAGE] : [];
  const failure = errors.length ? new Error("Communication processing requires intervention") : undefined;
  let forceForward = false, duplicate = false;
  try {
    if (errors.length) await issue("independent-monitor", errors.join(" ")); else await resolveIssue("independent-monitor");
  } catch (error) {
    if (!failure) throw error;
    forceForward = true;
    reportStateFailure(error);
  }
  try {
    const old = await get("health:monitor"), target = communicationHealthSentryTarget();
    const workerAt = worker ? timestamp(worker.data.at) : undefined;
    const trustworthyWorker = !worker || workerAt !== undefined && workerAt <= now.getTime()
      && (worker.data.lagging === undefined || typeof worker.data.lagging === "boolean");
    const reporting = target && trustworthyWorker ? reportingState(old?.data, target, reasons, now.toISOString(), forceForward) : undefined;
    // This is the existing operational write, with Sentry-only metadata. No
    // customer records, environment values or additional infrastructure change.
    await save(row("HEALTH", "health:monitor", { at: now.toISOString(), errors,
      ...(reporting ? { sentryHealth: reporting.state } : {}) }, { previous: old }), old);
    // A failed conditional write never marks the Error as a duplicate.
    duplicate = reporting?.duplicate === true;
  } catch (error) {
    if (!failure) throw error;
    forceForward = true;
    reportStateFailure(error);
  }
  // A metric filter/alarm watches this independent health result as well.
  console.log(JSON.stringify({ communicationMonitorFailures: errors.length }));
  if (failure) {
    if (duplicate && !forceForward) markRepeatedCommunicationHealthError(failure);
    throw failure;
  }
  return { errors };
};
