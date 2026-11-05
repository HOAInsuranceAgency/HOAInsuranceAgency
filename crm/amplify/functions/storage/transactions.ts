import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
type Write = NonNullable<TransactWriteCommandInput['TransactItems']>[number];
/** Validate the envelope; preserve each domain's conditions, audit, audience and
 * retry/idempotency semantics. This function never sends or retries a write. */
export function assertTransactionEnvelope(items: Write[], options: {
  maxBytes?: number; maxItemBytes?: number; keyFields?: (table: string) => readonly string[] | undefined; error: () => Error;
}) {
  if (items.length > 100 || options.maxBytes != null && Buffer.byteLength(JSON.stringify(items), 'utf8') > options.maxBytes ||
      options.maxItemBytes != null && items.some(item => Buffer.byteLength(JSON.stringify(item), 'utf8') > options.maxItemBytes!)) throw options.error();
  const targets = new Set<string>();
  for (const item of items) {
    const operation = item.Put ?? item.Update ?? item.Delete ?? item.ConditionCheck;
    if (!operation) throw options.error();
    const fields = 'Item' in operation ? options.keyFields?.(operation.TableName!) : undefined;
    const key = 'Item' in operation ? fields && Object.fromEntries(fields.map(field => [field, operation.Item?.[field]])) : operation.Key;
    // Unknown Put schemas stay at the domain boundary; do not guess their keys.
    if (!key) continue;
    if (Object.values(key).some(value => value == null)) throw options.error();
    const target = JSON.stringify([operation.TableName, Object.entries(key).sort(([a], [b]) => a.localeCompare(b))]);
    if (targets.has(target)) throw options.error();
    targets.add(target);
  }
}
