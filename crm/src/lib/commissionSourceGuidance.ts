import { formatUsdCents } from "../../../shared/money";
import { importedMoney, type StatementImportMapping } from "../../../shared/commissionImport";
import { reuseImportMapping, type CarrierImportTemplate } from "../../../shared/commissionIntake";

export const importColumnLabels: Record<keyof StatementImportMapping, string> = {
  policy: "Policy number", reference: "Transaction reference", amount: "Agency commission amount",
  effective: "Policy effective date", transaction: "Transaction type",
};
const aliases: Record<keyof StatementImportMapping, string[]> = {
  policy: ["policy", "policy number", "policy no", "policy #"],
  reference: ["reference", "transaction reference", "transaction ref", "line reference"],
  amount: ["amount", "agency commission amount", "agency commission", "commission amount"],
  effective: ["effective", "effective date", "policy effective date"],
  transaction: ["transaction", "transaction type"],
};
// Suggestions never approve a mapping. Ambiguous headings require an explicit choice.
// A saved carrier format remains authoritative, including intentionally omitted fields.
export function suggestImportMapping(headers: string[], template?: CarrierImportTemplate): StatementImportMapping {
  const mapping = reuseImportMapping(headers, template);
  if (template) return mapping;
  const normalized = headers.map(h => h.trim().toLowerCase().replace(/\s+/g, " "));
  for (const key of Object.keys(mapping) as (keyof StatementImportMapping)[]) {
    const matches = normalized.flatMap((h, i) => aliases[key].includes(h) ? [i] : []);
    if (matches.length === 1) mapping[key] = matches[0];
  }
  return mapping;
}
// Format only valid cents. Preserve invalid and unfinished input verbatim for correction.
export function displayCommissionAmount(value: string): string {
  if (!value.trim()) return value;
  try {
    const cents = importedMoney(value);
    return cents < 0 ? `(${formatUsdCents(-cents)})` : formatUsdCents(cents);
  } catch { return value; }
}

/** Choose a worksheet/header only when exactly one candidate has every required column. */
export function suggestImportTable(tables: { rows: string[][] }[], template?: CarrierImportTemplate) {
  const candidates: { sheet: number; header: number }[] = [];
  tables.forEach((table, sheet) => table.rows.slice(0, 20).forEach((row, header) => {
    const mapping = suggestImportMapping(row, template);
    if (mapping.policy >= 0 && mapping.reference >= 0 && mapping.amount >= 0 && header < table.rows.length - 1) candidates.push({sheet, header});
  }));
  return candidates.length === 1 ? candidates[0] : undefined;
}
