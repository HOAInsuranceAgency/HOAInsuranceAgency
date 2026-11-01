/** The final-copy boundary is immutable across deployment phases. Copied work
 * remains available for review; automatic processing never rewrites its state.
 */
const APP = "d1nuh9rw1hcuxo";
const ACCOUNT = "917680434255";
const BRANCHES = ["codex-hoa-account-migration", "codex-hoa-staging-migration"];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/;
const timestamp = (value: unknown) => typeof value === "string" && ISO.test(value) ? Date.parse(value) : NaN;

export function migrationPendingCutoff(): number | null {
  const app = process.env.HOA_MIGRATION_APP_ID;
  const raw = process.env.HOA_MIGRATION_PENDING_CUTOFF;
  if (!app && raw === undefined && process.env.HOA_MIGRATION_AUTH !== "true") return null;
  if (app !== APP || process.env.HOA_MIGRATION_PENDING_ACCOUNT !== ACCOUNT
    || process.env.AWS_REGION !== "us-east-1" || !BRANCHES.includes(process.env.HOA_MIGRATION_BRANCH ?? "")
    || !process.env.AWS_LAMBDA_FUNCTION_NAME?.startsWith(`amplify-${APP}-`)) {
    throw new Error("Inherited-work controls have a foreign destination binding");
  }
  // Closed previews have no final copy yet and must never process queued work.
  if (process.env.HOA_MIGRATION_PREVIEW === "true" && !raw) return Infinity;
  const cutoff = timestamp(raw);
  if (!Number.isFinite(cutoff) || cutoff > Date.now()) throw new Error("Inherited-work cutoff is missing or invalid");
  return cutoff;
}

type Pending = { createdAt?: unknown; kind?: unknown; version?: unknown; data?: unknown };
export function migrationPendingHeld(record: Pending): boolean {
  const cutoff = migrationPendingCutoff();
  if (cutoff === null) return false;
  const created = timestamp(record.createdAt);
  if (Number.isFinite(created) && created > cutoff && created <= Date.now()) return false;
  // Only the existing authenticated, optimistic-versioned and audited operation
  // review path can release a particular inherited operation. Ordinary updates
  // and provider callbacks cannot make old work new.
  const data = record.data as { migrationReview?: Record<string, unknown> } | undefined;
  const review = data?.migrationReview;
  return !(record.kind === "OPERATION" && Number.isFinite(created) && review
    && review.cutoff === process.env.HOA_MIGRATION_PENDING_CUTOFF
    && ["retry", "resolve"].includes(String(review.action))
    && typeof review.actor === "string" && !!review.actor.trim()
    && typeof review.reason === "string" && !!review.reason.trim()
    && Number.isInteger(review.sourceVersion) && Number(review.sourceVersion) >= 1
    && Number.isInteger(record.version) && Number(record.version) > Number(review.sourceVersion)
    && timestamp(review.at) > cutoff && timestamp(review.at) <= Date.now());
}

/** New repair cursors never reuse an inherited unfinished page/checkpoint. */
export function migrationPendingKey(id: string): string {
  const cutoff = migrationPendingCutoff();
  return cutoff === null ? id : `${id}:migration:${new Date(cutoff).toISOString()}`;
}

export function migrationProviderHeld(value: unknown, unit: "seconds" | "milliseconds" | "iso"): boolean {
  const cutoff = migrationPendingCutoff();
  if (cutoff === null) return false;
  const at = unit === "iso" ? timestamp(value)
    : (typeof value === "number" || typeof value === "string" && /^\d+(\.\d+)?$/.test(value)) ? Number(value) * (unit === "seconds" ? 1000 : 1) : NaN;
  return !Number.isFinite(at) || at <= cutoff || at > Date.now() + 300_000;
}

export function migrationOperationReview(record: Pending, actor: string, action: string, reason: string) {
  const cutoff = migrationPendingCutoff();
  if (cutoff === null || !migrationPendingHeld(record)) return undefined;
  if (!Number.isFinite(cutoff) || !Number.isFinite(timestamp(record.createdAt))) throw new Error("Inherited operation provenance needs migration review");
  return { cutoff: process.env.HOA_MIGRATION_PENDING_CUTOFF!, at: new Date().toISOString(), actor, action, reason, sourceVersion: record.version };
}
