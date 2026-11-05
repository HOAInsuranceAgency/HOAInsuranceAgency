import type { Policy } from '../../lib/client';

/** `12480.5` → `"12480.5"` for an input, `null` → `""`. */
export const toInput = (n: number | null | undefined): string =>
  typeof n === "number" && Number.isFinite(n) ? String(n) : "";

/** `""` → null, so a cleared box is "unknown" rather than a confident zero. */
export const fromInput = (v: string): number | null => {
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/** "POL-123 · Acme" for the policy picker, falling back to the dates. */
export function policyLabel(p: Policy): string {
  const number = p.policyNumber?.trim();
  const lines = (p.lines ?? []).filter(Boolean).join(", ");
  const term = p.effectiveDate ? ` (${p.effectiveDate})` : "";
  return `${number || lines || "Policy"}${term}`;
}