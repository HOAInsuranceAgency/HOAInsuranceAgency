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
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", currencySign: "accounting" }).format(importedMoney(value) / 100);
  } catch { return value; }
}
