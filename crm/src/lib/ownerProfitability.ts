import { client } from './client';
import { isRecord, privateApiCall } from './apiResponse';
import type { ApiRecord } from '../../../shared/apiResponse';
import { validateCompensationRecord, type EmployeeCompensation, type EmployeeProfitabilityResult } from '../../../shared/employeeProfitability';

export type ProfitabilityEmployee = { userId: string; name: string; salesperson?: boolean };
export interface OwnerProfitabilitySnapshot {
  ok: true; employees: ProfitabilityEmployee[]; compensations: Record<string, EmployeeCompensation>;
  report: EmployeeProfitabilityResult; reportStale?: boolean;
}
function compensation(value: unknown): value is EmployeeCompensation {
  try { validateCompensationRecord(value); return true; } catch { return false; }
}
const amountKeys = ['grossCommissionCents', 'brokerFeeCents', 'brokerFeeRefundedCents', 'totalAgencyRevenueCents', 'producerShareCents', 'netRevenueCents', 'salaryCents', 'contributionCents'];
const knownKeys = ['knownGrossCommissionCents', 'knownBrokerFeeCents', 'knownBrokerFeeRefundedCents', 'knownTotalAgencyRevenueCents', 'knownProducerShareCents', 'knownNetRevenueCents'];
const countKeys = ['policyCount', 'feePolicyCount', 'missingCommissionCount', 'missingCompensationCount'];
const textList = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string');
function amounts(value: ApiRecord) {
  return amountKeys.every(key => value[key] === null || Number.isSafeInteger(value[key]))
    && [...knownKeys, ...countKeys].every(key => Number.isSafeInteger(value[key])) && typeof value.complete === 'boolean';
}
function report(value: unknown): value is EmployeeProfitabilityResult {
  return isRecord(value) && typeof value.from === 'string' && typeof value.to === 'string'
    && Array.isArray(value.rows) && value.rows.every(row => isRecord(row) && (row.userId === null || typeof row.userId === 'string') && typeof row.name === 'string' && amounts(row) && textList(row.warnings))
    && isRecord(value.totals) && amounts(value.totals) && ['incompleteEmployeeCount', 'knownSalaryCents', 'knownContributionCents'].every(key => Number.isSafeInteger(value.totals && (value.totals as ApiRecord)[key]))
    && Number.isSafeInteger(value.cancelledPolicyCount) && Number.isSafeInteger(value.undatedPolicyCount) && textList(value.warnings);
}
export async function readOwnerProfitability(from: string, to: string): Promise<OwnerProfitabilitySnapshot> {
  return await privateApiCall(client.queries.ownerProfitability({ from, to }),
    (value): value is ApiRecord & OwnerProfitabilitySnapshot => value.ok === true && Array.isArray(value.employees)
      && value.employees.every(employee => isRecord(employee) && typeof employee.userId === 'string' && typeof employee.name === 'string' && (employee.salesperson === undefined || typeof employee.salesperson === 'boolean'))
      && isRecord(value.compensations) && Object.entries(value.compensations).every(([userId, record]) => compensation(record) && record.userId === userId)
      && report(value.report),
    { fallback: 'Could not load owner profitability.' });
}
export async function saveOwnerCompensation(value: EmployeeCompensation): Promise<EmployeeCompensation> {
  const result = await privateApiCall(client.mutations.saveEmployeeCompensation({ userId: value.userId, version: value.version, terms: JSON.stringify(value.terms) }),
    (result): result is ApiRecord & { compensation: EmployeeCompensation } => compensation(result.compensation) && result.compensation.userId === value.userId && result.compensation.version >= value.version,
    { fallback: 'Could not save pay settings.' });
  return result.compensation;
}
