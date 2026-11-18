export const SALESPERSON_ACCESS_KEY = 'settings:salesperson-access:v1';
export interface SalespersonAccessPolicy {
  visibility: 'ASSIGNED' | 'LEADS' | 'ALL';
  level: 'READ' | 'COLLABORATE' | 'EDIT';
  send: boolean;
  invoice: boolean;
  bind: boolean;
}
export type AccountCapability = 'read' | 'collaborate' | 'edit' | 'send' | 'invoice' | 'bind' | 'restricted';
export const DEFAULT_SALESPERSON_ACCESS: SalespersonAccessPolicy = {
  visibility: 'ASSIGNED', level: 'READ', send: false, invoice: false, bind: false,
};
export function parseSalespersonAccess(value: unknown): SalespersonAccessPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose valid salesperson access settings.');
  const p = value as Record<string, unknown>;
  if (Object.keys(p).some(k => !Object.hasOwn(DEFAULT_SALESPERSON_ACCESS, k)) ||
      !['ASSIGNED', 'LEADS', 'ALL'].includes(String(p.visibility)) ||
      !['READ', 'COLLABORATE', 'EDIT'].includes(String(p.level)) ||
      ['send', 'invoice', 'bind'].some(k => typeof p[k] !== 'boolean')) throw new Error('Choose valid salesperson access settings.');
  return { visibility: p.visibility, level: p.level, send: p.send, invoice: p.invoice, bind: p.bind } as SalespersonAccessPolicy;
}
export function policyAllows(p: SalespersonAccessPolicy, capability: AccountCapability): boolean {
  if (capability === 'read') return true;
  if (capability === 'restricted') return false;
  if (capability === 'collaborate') return p.level !== 'READ';
  if (capability === 'edit') return p.level === 'EDIT';
  return p[capability];
}
