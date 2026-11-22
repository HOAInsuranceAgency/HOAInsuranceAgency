import type { IntakeSettlement, StatementIntake } from '../../../../shared/commissionIntake';
import { STATEMENT_INDEX_STATE, intakeSettlementsKind } from './statement-index';
import * as store from './store';
export async function requireStatementIndexes() {
  if (await store.get('INDEX_STATE', STATEMENT_INDEX_STATE)) return;
  const existing = await Promise.all(['STATEMENT_INTAKE', 'INTAKE_SETTLEMENT'].map(kind => store.page(kind, undefined, 1)));
  if (existing.some(p => p.items.length)) throw new Error('Statement history lookup upgrade is required. Ask the administrator to finish the commission statement backfill before continuing. No financial records were changed.');
}
async function referenced<T>(index: string, kind: string): Promise<T[]> {
  const refs = await store.list<{id:string}>(index);
  const rows = await store.getMany<T>(refs.map(r => ({kind, id:r.id})));
  if (rows.length !== refs.length) throw new Error('Statement lookup records are incomplete. Refresh before proceeding.');
  return rows;
}
export async function intakeSettlements(id: string) {
  await requireStatementIndexes();
  const rows = await referenced<IntakeSettlement>(intakeSettlementsKind(id), 'INTAKE_SETTLEMENT');
  if (rows.some(s => s.intakeId !== id)) throw new Error('Statement settlement references require repair.');
  return rows;
}
export async function activeSettlementWork(indexesVerified = false) {
  if (!indexesVerified) await requireStatementIndexes();
  return (await referenced<IntakeSettlement>('INTAKE_SETTLEMENT_ACTIVE', 'INTAKE_SETTLEMENT')).filter(s => ['RECORDED','POSTING'].includes(s.status));
}
export async function activeIntakeWork(indexesVerified = false) {
  if (!indexesVerified) await requireStatementIndexes();
  return (await referenced<StatementIntake>('INTAKE_ACTIVE', 'STATEMENT_INTAKE')).filter(s => s.status === 'OPEN' && (!s.rowCount || s.completedRows !== s.rowCount));
}
export async function statementSourceLinks(ids: string[]) {
  const unique = [...new Set(ids)];
  const result: {id:string;intakeId:string}[] = [];
  for (let i=0;i<unique.length;i+=5000) result.push(...await store.getMany<{id:string;intakeId:string}>(unique.slice(i,i+5000).map(id => ({kind:'INTAKE_STATEMENT_LINK',id}))));
  return result;
}
