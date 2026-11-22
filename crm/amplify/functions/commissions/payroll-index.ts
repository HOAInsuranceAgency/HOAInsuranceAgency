import type { Change, Transaction } from './store';

export const APPROVED_PAYROLL_KIND = 'PAYROLL_APPROVED';
export const APPROVED_PAYROLL_INDEX_STATE = 'approved-payroll-cycles-v1';

/** Keep the active reference in the same transaction as the source status transition. */
export function approvedPayrollIndexWrites(table: string, change: Change): Transaction {
  if (change.kind !== 'PAYROLL_CYCLE') return [];
  const wasApproved = change.previous?.status === 'APPROVED';
  const approved = change.value.status === 'APPROVED';
  if (wasApproved === approved) return [];
  const key = { kind: APPROVED_PAYROLL_KIND, id: change.value.id };
  return approved ? [{ Put: { TableName: table, Item: key } }] : [{ Delete: { TableName: table, Key: key } }];
}
