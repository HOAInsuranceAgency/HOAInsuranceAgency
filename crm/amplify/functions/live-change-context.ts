import { AsyncLocalStorage } from 'node:async_hooks';

export type LiveChangeChannel = 'Crm' | 'Owner' | 'Personal';
export type LiveChangeSet = { crm: boolean; owner: boolean; personal: Set<string> };
type Batch = LiveChangeSet & { closed: boolean };
const batches = new AsyncLocalStorage<Batch | undefined>();

/** Each Lambda invocation owns its queue; concurrent or nested work cannot mix audiences. */
export function queueLiveChange(channel: LiveChangeChannel, userId?: string): boolean {
  const batch = batches.getStore();
  if (!batch || batch.closed) return false;
  if (channel === 'Crm') batch.crm = true;
  else if (channel === 'Owner') batch.owner = true;
  else if (userId) batch.personal.add(userId);
  return true;
}

export async function runLiveChangeBatch<T>(work: () => Promise<T>, flush: (changes: LiveChangeSet) => Promise<void>): Promise<T> {
  const existing = batches.getStore();
  if (existing && !existing.closed) return work();
  const batch: Batch = { crm: false, owner: false, personal: new Set(), closed: false };
  try { return await batches.run(batch, work); }
  finally {
    batch.closed = true;
    // Flush once after all committed work, including commits preceding a later
    // failure. Flushes run outside the queue so they actually reach AppSync.
    try { await batches.run(undefined, () => flush(batch)); } catch { /* Best effort only. */ }
  }
}
