import { day, integer, MONEY_MAX, required, sum, type CommissionStatement } from './commissions';
import type { IntakeSettlement, StatementIntake } from './commissionIntake';

export interface CommissionDeposit {
  id: string; version: number; payor: string; carrierId?: string; reference: string;
  receivedOn: string; totalCents: number; evidence: string;
  status: 'AWAITING_REMITTANCE' | 'LINKED' | 'NO_EMPLOYEE_COMMISSION' | 'VOID';
  intakeId?: string; settlementId?: string; resolutionReason?: string;
  createdAt: string; createdBy: string;
}
export const depositReference = (reference: string) => reference.trim().toLowerCase();
export function validateDeposit(input: Record<string, unknown>, today: string) {
  const receivedOn = day(input.receivedOn);
  if (receivedOn > today) throw new Error('Record a deposit only after it arrives.');
  if (input.confirmed !== true) throw new Error('Confirm the actual bank deposit and evidence.');
  return {
    payor: required(input.payor, 'the bank payor description', 200),
    reference: required(input.reference, 'a unique bank deposit reference', 200),
    receivedOn, totalCents: integer(input.totalCents, 1, MONEY_MAX, 'deposit amount'),
    evidence: required(input.evidence, 'bank receipt evidence', 2000),
    ...(input.carrierId ? { carrierId: required(input.carrierId, 'a carrier', 128) } : {}),
  };
}
export function statementReceiptBalance(intake: StatementIntake, settlements: IntakeSettlement[]) {
  return intake.totalCents === undefined ? undefined : intake.totalCents - sum(settlements.filter(s => s.intakeId === intake.id && s.status !== 'VOID').map(s => s.totalCents));
}
/** Suggestions never establish a match, actual receipt or employee eligibility. */
export function depositSuggestions(deposit: CommissionDeposit, intakes: StatementIntake[], settlements: IntakeSettlement[]) {
  return intakes.filter(s => s.status === 'OPEN' && (!deposit.carrierId || s.carrierId === deposit.carrierId))
    .map(intake => ({ intake, balance: statementReceiptBalance(intake, settlements) }))
    .filter(x => x.balance !== undefined && x.balance >= deposit.totalCents)
    .map(x => ({ ...x, exact: x.balance === deposit.totalCents, reason: (deposit.carrierId ? 'Same carrier; ' : 'Carrier must be confirmed; ') + (x.balance === deposit.totalCents ? 'amount matches unpaid statement balance' : 'deposit fits part of the statement balance') }))
    .sort((a,b) => Number(b.exact) - Number(a.exact) || a.intake.documentReceivedOn.localeCompare(b.intake.documentReceivedOn) || a.intake.id.localeCompare(b.intake.id));
}
/** Unclassified received money participates in the existing cutoff reconciliation guard. */
export function depositPayrollStatements(deposits: CommissionDeposit[]): CommissionStatement[] {
  return deposits.filter(d => d.status === 'AWAITING_REMITTANCE').map(d => ({
    id: 'deposit:' + d.id, version: d.version, carrierId: d.carrierId ?? '',
    reference: 'unmatched deposit ' + d.reference + ' (awaiting remittance)', source: '',
    receivedOn: d.receivedOn, settlementRef: d.reference, settlementType: 'DEPOSIT',
    totalCents: d.totalCents, lines: [], status: 'DRAFT',
  }));
}
