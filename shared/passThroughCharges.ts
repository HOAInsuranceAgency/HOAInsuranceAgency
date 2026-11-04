export const PASS_THROUGH_CHARGE_KINDS = ['CARRIER_FEE', 'WHOLESALER_FEE', 'TAX', 'SURPLUS_LINES', 'STAMPING_FEE'] as const;
export type PassThroughChargeKind = typeof PASS_THROUGH_CHARGE_KINDS[number];
export interface PassThroughCharge { id: string; kind: PassThroughChargeKind; description: string; amountCents: number; }
export const MAX_PASS_THROUGH_CHARGES = 30;
export const MAX_PASS_THROUGH_TOTAL_CENTS = 1_000_000_000;

/** Optional legacy values are empty; malformed recorded costs always fail closed. */
export function normalizePassThroughCharges(value: unknown): PassThroughCharge[] {
  if (value == null) return [];
  let parsed: unknown = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { throw new Error('Review the recorded carrier, wholesaler and tax charges.'); }
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_PASS_THROUGH_CHARGES) throw new Error('Record no more than 30 carrier, wholesaler and tax charges.');
  const ids = new Set<string>(); let total = 0;
  return parsed.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['id', 'kind', 'description', 'amountCents'].includes(key))) throw new Error('Review each recorded carrier, wholesaler and tax charge.');
    const row = item as Record<string, unknown>;
    if (typeof row.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(row.id) || ids.has(row.id)) throw new Error('Each pass-through charge needs a unique stable ID.');
    if (!PASS_THROUGH_CHARGE_KINDS.includes(row.kind as PassThroughChargeKind)) throw new Error('Choose a carrier fee, wholesaler fee, tax, surplus lines or stamping fee.');
    if (typeof row.description !== 'string' || !row.description.trim() || row.description.length > 160 || /[\x00-\x1f\x7f]/.test(row.description)) throw new Error('Give each pass-through charge a client label of no more than 160 characters.');
    if (typeof row.amountCents !== 'number' || !Number.isSafeInteger(row.amountCents) || row.amountCents <= 0 || row.amountCents > MAX_PASS_THROUGH_TOTAL_CENTS) throw new Error('Pass-through charges must be positive whole cents within the supported limit.');
    total += row.amountCents;
    if (!Number.isSafeInteger(total) || total > MAX_PASS_THROUGH_TOTAL_CENTS) throw new Error('The pass-through charge total exceeds the supported limit.');
    ids.add(row.id);
    return { id: row.id, kind: row.kind as PassThroughChargeKind, description: row.description.trim(), amountCents: row.amountCents };
  });
}
export const passThroughTotalCents = (value: unknown) => normalizePassThroughCharges(value).reduce((total, charge) => total + charge.amountCents, 0);
export const passThroughTotal = (value: unknown) => passThroughTotalCents(value) / 100;

/** Public, reviewed conditions are separate from the agency's private notes. */
export function normalizeClientConditions(value: unknown): string {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > 6000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error('Client conditions must be text of no more than 6,000 characters.');
  return value.replace(/\r\n?/g, '\n').trim();
}
