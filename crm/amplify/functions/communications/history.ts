import { row, type Row } from "./store";

export interface HistoryJob {
  conversationId: string;
  next?: string;
  attempts?: number;
  error?: string;
  firstFailureAt?: string;
  completedAt?: string;
}
// Reconciliation is a repair sweep. Webhooks remain the immediate capture path.
export const HISTORY_RECHECK_MS = 30 * 60_000;
export const historyStopped = (job: Row<HistoryJob>) => !job.dueAt && (!!job.data.error || (job.data.attempts ?? 0) >= 12);
export function historyDue(job?: Row<HistoryJob>, now = Date.now()) {
  if (!job) return true;
  if (job.dueAt || historyStopped(job)) return false;
  return now - Date.parse(job.data.completedAt ?? job.updatedAt) >= HISTORY_RECHECK_MS;
}
/** Explicit restart from page one. Stable message receipts make replay safe;
 * delivery operations, lead dates and the capture activation boundary are untouched. */
export function restartHistory(id: string, conversationId: string, accountId?: string, previous?: Row<HistoryJob>) {
  return row<HistoryJob>("CONVERSATION_BACKFILL", id, { conversationId, attempts: 0 }, { accountId, previous, dueAt: new Date().toISOString() });
}
