import { createHash } from 'node:crypto';
import { depositReference } from '../../../../shared/commissionDeposits';
import type { IntakeSettlement, StatementIntake } from '../../../../shared/commissionIntake';
import type { Data, Change, Transaction } from './store';
export const STATEMENT_INDEX_STATE = 'statement-lookups-v1';
export const intakeSettlementsKind = (id: string) => 'INTAKE_SETTLEMENTS#' + id;
export const settlementBankKey = (reference: string) => createHash('sha256').update(depositReference(reference)).digest('hex');
/** Derived references commit atomically with the authoritative row. No financial values are copied. */
export function statementIndexWrites(table: string, change: Change): Transaction {
  const row = change.value;
  const ref = (kind: string, extra: Data = {}) => ({ Put: { TableName: table, Item: { kind, id: row.id, ...extra } } });
  const remove = (kind: string) => ({ Delete: { TableName: table, Key: { kind, id: row.id } } });
  if (change.kind === 'STATEMENT_INTAKE') {
    const s = row as unknown as StatementIntake;
    return [s.status === 'OPEN' && (!s.rowCount || s.completedRows !== s.rowCount) ? ref('INTAKE_ACTIVE') : remove('INTAKE_ACTIVE')];
  }
  if (change.kind !== 'INTAKE_SETTLEMENT') return [];
  const s = row as unknown as IntakeSettlement;
  const writes: Transaction = [ref(intakeSettlementsKind(s.intakeId)),
    ['RECORDED', 'POSTING'].includes(s.status) ? ref('INTAKE_SETTLEMENT_ACTIVE') : remove('INTAKE_SETTLEMENT_ACTIVE'),
    { Put: { TableName: table, Item: { kind: 'INTAKE_BANK_REFERENCE', id: settlementBankKey(s.reference), settlementId: s.id } } }];
  const oldIds = new Set((change.previous?.statementIds as string[] | undefined) ?? []);
  for (const id of s.statementIds ?? []) if (!oldIds.has(id)) writes.push({ Put: { TableName: table, Item: { kind: 'INTAKE_STATEMENT_LINK', id, intakeId: s.intakeId, settlementId: s.id } } });
  return writes;
}
