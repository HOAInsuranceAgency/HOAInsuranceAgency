import { day, decimal, integer, MONEY_MAX, sum, type CommissionPolicy, type StatementLine } from './commissions';

export type StatementImportMapping = { policy: number; reference: number; amount: number; effective: number; transaction: number };
export const emptyImportMapping = (): StatementImportMapping => ({ policy: -1, reference: -1, amount: -1, effective: -1, transaction: -1 });
/** Bounded CSV/TSV parser. Values are data and are never evaluated as formulas. */
export function parseStatementCsv(input: string, delimiter = ','): string[][] {
  if (![',', '\t', ';'].includes(delimiter) || new TextEncoder().encode(input).length > 2_000_000) throw new Error('Use a CSV/TSV file under 2 MB.');
  const text = input.replace(/^\uFEFF/, ''), rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false, closed = false;
  const cell = () => { if (field.length > 2000 || row.length >= 64) throw new Error('Statement cells or columns exceed the import limit.'); row.push(field); field = ''; closed = false; };
  const record = () => { cell(); rows.push(row); row = []; if (rows.length > 1001) throw new Error('Import up to 1,000 statement rows at a time.'); };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } }
      else field += ch;
    } else if (ch === delimiter) cell();
    else if (ch === '\r' || ch === '\n') { record(); if (ch === '\r' && text[i + 1] === '\n') i++; }
    else if (closed) { if (ch !== ' ' && ch !== '\t') throw new Error('Unexpected text after a quoted CSV value.'); }
    else if (ch === '"') { if (field.length) throw new Error('Quote inside an unquoted CSV value.'); quoted = true; }
    else field += ch;
  }
  if (quoted) throw new Error('Unclosed quoted CSV value.');
  if (field.length || row.length || closed) record();
  if (rows.length < 2 || !rows[0].some(c => c.trim())) throw new Error('Include a header row and at least one transaction.');
  return rows;
}
export function importedMoney(value: string): number {
  let text = value.trim();
  const parentheses = /^\(.*\)$/.test(text);
  if (parentheses) text = text.slice(1, -1).trim();
  text = text.replace(/^\$/, '');
  if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text) || (parentheses && text.startsWith('-'))) throw new Error('Use USD amounts with no more than two decimal places.');
  const amount = decimal((parentheses ? '-' : '') + text.replace(/,/g, ''));
  return integer(amount, -MONEY_MAX, MONEY_MAX, 'agency commission');
}
/** Match exact carrier + policy number + optional effective date. Ambiguity stays unresolved. */
export function prepareStatementImport(rows: string[][], mapping: StatementImportMapping, policies: CommissionPolicy[], carrierId: string, start = 1, count = 20) {
  if (!carrierId) throw new Error('Choose the carrier before importing.');
  integer(start, 1, rows.length - 1, 'first data row'); integer(count, 1, 20, 'import count');
  const selected = Object.values(mapping).filter(i => i >= 0);
  if ([mapping.policy, mapping.reference, mapping.amount].some(i => !Number.isInteger(i) || i < 0 || i >= rows[0].length) || new Set(selected).size !== selected.length) throw new Error('Map distinct policy, transaction reference, and agency commission columns.');
  for (const index of selected) integer(index, 0, rows[0].length - 1, 'column');
  const get = (row: string[], index: number) => index < 0 ? '' : (row[index] ?? '').trim();
  const references = rows.slice(1).map(row => get(row, mapping.reference).toLowerCase());
  const known = new Set(policies.filter(p => p.carrierId === carrierId).flatMap(p => p.entries.map(e => e.lineRef.toLowerCase())));
  const errors: string[] = [], warnings: string[] = [], lines: StatementLine[] = [];
  for (let index = start; index < Math.min(rows.length, start + count); index++) {
    const row = rows[index], label = `Row ${index + 1}`;
    if (!row.some(c => c.trim())) continue;
    try {
      const lineRef = get(row, mapping.reference), policyNumber = get(row, mapping.policy), effective = get(row, mapping.effective);
      if (!lineRef || !policyNumber) throw new Error('Policy number and transaction reference are required.');
      if (references.filter(r => r === lineRef.toLowerCase()).length !== 1 || known.has(lineRef.toLowerCase())) throw new Error('Transaction reference is duplicated in this file or already posted.');
      if (effective) day(effective);
      const transaction = get(row, mapping.transaction).toUpperCase();
      const kinds: Record<string, StatementLine['kind']> = { RECEIPT: 'RECEIPT', COMMISSION: 'RECEIPT', NEW: 'RECEIPT', RENEWAL: 'RECEIPT', REVERSAL: 'REVERSAL', RESTORATION: 'RESTORATION' };
      const kind = mapping.transaction < 0 ? 'RECEIPT' : kinds[transaction];
      if (!kind) throw new Error('Unrecognized transaction type. Map to RECEIPT, REVERSAL, or RESTORATION; review endorsements separately.');
      const agencyCents = importedMoney(get(row, mapping.amount));
      if (!agencyCents || (kind === 'REVERSAL' ? agencyCents > 0 : agencyCents < 0)) throw new Error('Commission amount and transaction sign disagree.');
      const matches = policies.filter(p => p.carrierId === carrierId && p.policyNumber.trim().toUpperCase() === policyNumber.toUpperCase() && (!effective || p.effectiveDate === effective));
      if (matches.length !== 1) warnings.push(`${label}: ${matches.length ? 'multiple policy terms match' : 'no exact policy match'}; select the correct term in the draft.`);
      if (kind !== 'RECEIPT') warnings.push(`${label}: link the original receipt or reversal before saving.`);
      lines.push({ sourceRow: index + 1, policyId: matches.length === 1 ? matches[0].id : '', lineRef, agencyCents, kind, eligible: false, reviewStatus: 'PENDING', eligibilityNote: '' });
    } catch (error) { errors.push(`${label}: ${error instanceof Error ? error.message : 'Invalid row.'}`); }
  }
  if (!lines.length && !errors.length) errors.push('The selected rows contain no transactions.');
  return { lines, errors, warnings, totalCents: sum(lines.map(l => l.agencyCents)), remainingRows: Math.max(0, rows.length - start - count) };
}
