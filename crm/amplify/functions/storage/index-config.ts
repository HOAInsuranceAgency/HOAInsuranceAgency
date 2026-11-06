import type { ModelIndexKey } from './model-indexes';

type IndexConfiguration = Readonly<Record<string, unknown>>;
/** Parse deployment configuration only; never accept a request-supplied map.
 * Validate the selected value when resolving it, leaving unrelated entries alone. */
export function parseAccessIndexes(raw: string | undefined, error: () => Error): IndexConfiguration {
  let parsed: unknown;
  try { parsed = JSON.parse(raw ?? '{}'); } catch { throw error(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw error();
  return parsed as IndexConfiguration;
}

/** Canonical callers use flat model.field keys. Only the broker-fee account
 * reader opts into its existing nested/model-level configuration and fallback. */
export function resolveAccessIndex(indexes: IndexConfiguration, key: ModelIndexKey, options: {
  error: () => Error; nested?: boolean; fallback?: string;
}): string {
  const [model, field] = key.split('.');
  const configured = indexes[key] ?? (options.nested ? indexes[model] : undefined);
  const value = options.nested && configured && typeof configured === 'object' && !Array.isArray(configured)
    ? (configured as Record<string, unknown>)[field] : configured;
  if ((value == null || value === '') && options.fallback) return options.fallback;
  if (typeof value !== 'string' || !value) throw options.error();
  return value;
}
