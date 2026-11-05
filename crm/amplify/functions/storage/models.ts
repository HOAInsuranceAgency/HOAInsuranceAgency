import { ACCOUNT_MODELS, SHARED_MODELS } from '../crm-access/policy';

export type StoredModel = typeof ACCOUNT_MODELS[number] | typeof SHARED_MODELS[number] | 'Communication';
const models = new Set<string>([...ACCOUNT_MODELS, ...SHARED_MODELS, 'Communication']);
export function storedModel(value: string, error: () => Error): StoredModel {
  if (!models.has(value)) throw error();
  return value as StoredModel;
}
/** Custom identifiers match the generated schema; all other models use id. */
export const modelKeyName = (model: StoredModel): 'id' | 'accountId' =>
  model === 'GlApplication' || model === 'DoApplication' ? 'accountId' : 'id';
export const modelKey = (model: StoredModel, value: string) => ({ [modelKeyName(model)]: value });

/** Resolve trusted deployment configuration only. Authorization and IAM remain
 * at each caller; this resolver never accepts a browser-provided table name. */
export function resolveModelTable(model: StoredModel, options: {
  envNames?: readonly string[]; useTableMap?: boolean; environment?: Record<string, string | undefined>; error: () => Error;
}): string {
  const env = options.environment ?? process.env;
  if (model === 'Communication') {
    if (!env.COMMUNICATION_TABLE) throw options.error();
    return env.COMMUNICATION_TABLE;
  }
  let tables: Record<string, unknown>;
  try {
    const parsed: unknown = options.useTableMap === false ? {} : JSON.parse(env.ACCESS_TABLES ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw options.error();
    tables = parsed as Record<string, unknown>;
  } catch { throw options.error(); }
  const explicit = tables[model];
  const configured = explicit ?? options.envNames?.map(name => env[name]).find(Boolean);
  const name = configured ?? (env.ACCESS_API_ID ? `${model}-${env.ACCESS_API_ID}-NONE` : undefined);
  if (typeof name !== 'string' || !name) throw options.error();
  return name;
}
