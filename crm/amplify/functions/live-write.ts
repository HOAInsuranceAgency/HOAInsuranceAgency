import { publishCrmChange, publishOwnerChange, publishPersonalChange } from './live-changes';
import { runLiveChangeBatch } from './live-change-context';

/** Preserve the handler contract while coalescing its committed changes into trailing pulses. */
export function batchLiveChanges<T extends (...args: any[]) => any>(handler: T): T {
  return (async (...args: Parameters<T>) => runLiveChangeBatch(
    () => Promise.resolve(handler(...args)),
    async changes => {
      await Promise.allSettled([
        ...(changes.crm ? [publishCrmChange()] : []),
        ...(changes.owner ? [publishOwnerChange()] : []),
        ...[...changes.personal].map(publishPersonalChange),
      ]);
    },
  )) as T;
}

/** Notification delivery cannot change the outcome of an already committed write. */
async function afterWrite<T>(write: Promise<T>, publish: () => Promise<void>): Promise<T> {
  const result = await write;
  try { await publish(); } catch { /* The periodic refresh remains the recovery path. */ }
  return result;
}

export function sendCrmWrite<T>(write: Promise<T>): Promise<T> {
  return afterWrite(write, publishCrmChange);
}

export function sendOwnerWrite<T>(write: Promise<T>): Promise<T> {
  return afterWrite(write, publishOwnerChange);
}

/** Private pay changes reach Owners and only the affected producer's own view. */
export function sendCommissionWrite<T>(write: Promise<T>, producerIds: Iterable<string>): Promise<T> {
  const ids = [...new Set(producerIds)].filter(id => typeof id === 'string' && id.length > 0);
  return afterWrite(write, async () => {
    await Promise.allSettled([publishOwnerChange(), ...ids.map(publishPersonalChange)]);
  });
}
