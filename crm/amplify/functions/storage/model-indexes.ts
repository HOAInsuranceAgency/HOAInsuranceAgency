import { ACCOUNT_MODELS, listPartition, type ParentListPartitions } from '../crm-access/policy';

/** Configuration keys for generated model indexes. Private domain GSIs keep
 * their own declarations. This metadata is also loaded by synthesis, so its
 * imports must stay inside amplify/ and must not initialize SDK clients. */
export type IndexedAccountModel = Exclude<typeof ACCOUNT_MODELS[number], 'Account' | 'GlApplication' | 'DoApplication'>;
export type ModelIndexField<Model extends IndexedAccountModel> =
  Model extends 'Document' ? 'entityId' | 'entityType' :
  Model extends 'Activity' ? 'entityId' :
  Model extends keyof ParentListPartitions ? ParentListPartitions[Model] : 'accountId';
export type ModelIndexKey<Model extends IndexedAccountModel = IndexedAccountModel> = {
  [Name in Model]: `${Name}.${ModelIndexField<Name>}`;
}[Model];
export type ModelIndexMap = Partial<Record<ModelIndexKey, string>>;
export type AccountIndexModel = {
  [Model in IndexedAccountModel]: 'accountId' extends ModelIndexField<Model> ? Model : never;
}[IndexedAccountModel];

const indexedModels = new Set<string>(ACCOUNT_MODELS.filter(model => !['Account', 'GlApplication', 'DoApplication'].includes(model)));
export function isIndexedAccountModel(model: string): model is IndexedAccountModel {
  return indexedModels.has(model);
}
export function modelIndexFields<Model extends IndexedAccountModel>(model: Model): readonly ModelIndexField<Model>[] {
  return (model === 'Document' ? ['entityId', 'entityType'] : [listPartition(model)]) as ModelIndexField<Model>[];
}
export function modelIndexKey<Model extends IndexedAccountModel>(model: Model, field: ModelIndexField<NoInfer<Model>>): ModelIndexKey<Model> {
  return `${model}.${field}` as ModelIndexKey<Model>;
}
/** Dynamic model-list callers must validate the pair, not assert an arbitrary
 * string is a declared key. Authorization remains at the caller. */
export function requireModelIndexKey(model: string, field: string, error: () => Error): ModelIndexKey {
  if (!isIndexedAccountModel(model) || !(modelIndexFields(model) as readonly string[]).includes(field)) throw error();
  return modelIndexKey(model, field as ModelIndexField<typeof model>);
}
export const INVOICE_INDEX_KEYS = [modelIndexKey('Invoice', 'accountId'), modelIndexKey('InvoiceLine', 'invoiceId')] as const;
