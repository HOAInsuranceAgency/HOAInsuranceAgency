import { BatchGetCommand, type BatchGetCommandOutput, type BatchGetCommandInput } from '@aws-sdk/lib-dynamodb';

type Key = Record<string, unknown>;
type TableRead = NonNullable<BatchGetCommandInput['RequestItems']>[string];
export class ReadDeadlineExceeded extends Error {}
export interface CompleteBatchOptions {
  send: (command: BatchGetCommand) => Promise<Pick<BatchGetCommandOutput, 'Responses' | 'UnprocessedKeys'>>;
  table: string;
  keys: Key[];
  maxKeys: number;
  attempts: number;
  concurrency?: number;
  read?: Omit<TableRead, 'Keys'>;
  deadline?: number;
  sizeError: () => Error;
  incompleteError: () => Error;
}
/** Read retries only: a throttled/unprocessed key is never a missing record.
 * Callers retain table/projection/consistency, request budgets and domain checks. */
export async function batchGetComplete<T>(options: CompleteBatchOptions): Promise<T[]> {
  const { send, table, maxKeys, attempts, read, deadline, sizeError, incompleteError } = options;
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(maxKeys) || maxKeys < 0 || !Number.isInteger(attempts) || attempts < 1 ||
      !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('Invalid batch read configuration.');
  const keys = [...new Map(options.keys.map(key => [JSON.stringify(Object.entries(key).sort(([a], [b]) => a.localeCompare(b))), key])).values()];
  if (keys.length > maxKeys) throw sizeError();
  const output: T[] = [];
  const deadlineCheck = (delay = 0) => {
    if (deadline != null && Date.now() + delay >= deadline) throw new ReadDeadlineExceeded('The batch read deadline was reached.');
  };
  for (let offset = 0; offset < keys.length; offset += 100 * concurrency) {
    const wave = await Promise.allSettled(Array.from({ length: Math.ceil(Math.min(100 * concurrency, keys.length - offset) / 100) }, async (_, index) => {
      let pending = keys.slice(offset + index * 100, offset + (index + 1) * 100);
      const rows: T[] = [];
      for (let attempt = 0; pending.length && attempt < attempts; attempt++) {
        deadlineCheck();
        const result = await send(new BatchGetCommand({ RequestItems: { [table]: { ...read, Keys: pending } } }));
        rows.push(...(result.Responses?.[table] ?? []) as T[]);
        pending = result.UnprocessedKeys?.[table]?.Keys ?? [];
        if (pending.length && attempt + 1 < attempts) {
          const delay = Math.min(25 * 2 ** attempt, 200);
          deadlineCheck(delay);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
      if (pending.length) throw incompleteError();
      return rows;
    }));
    // Never return an earlier partial wave or abandon concurrent read failures.
    const failure = wave.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
    for (const result of wave) if (result.status === 'fulfilled') output.push(...result.value);
  }
  return output;
}
