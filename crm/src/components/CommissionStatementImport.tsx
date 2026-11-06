import { useState } from 'react';
import CommissionPanel from './CommissionPanel';
import { emptyImportMapping, parseStatementCsv, prepareStatementImport } from '../../../shared/commissionImport';
import type { CommissionPolicy, StatementLine } from '../../../shared/commissions';
import { readCommissionWorkbook } from '../lib/commissionWorkbook';

export default function CommissionStatementImport({ carrierId, policies, apply, disabled, file }: { carrierId: string; policies: CommissionPolicy[]; apply: (lines: StatementLine[]) => void; disabled: boolean; file: File | null }) {
  const [sheets, setSheets] = useState<{ name: string; rows: string[][] }[]>([]), [sheet, setSheet] = useState(0);
  const [mapping, setMapping] = useState(emptyImportMapping), [start, setStart] = useState(1), [count, setCount] = useState(20);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [reviewed, setReviewed] = useState(false);
  const rows = sheets[sheet]?.rows;
  let preview: ReturnType<typeof prepareStatementImport> | undefined, mappingError = '';
  if (rows) try { preview = prepareStatementImport(rows, mapping, policies, carrierId, start, count); } catch (e) { mappingError = e instanceof Error ? e.message : 'Review column mapping.'; }
  async function load(file: File) {
    setBusy(true); setError(''); setSheets([]); setReviewed(false);
    try {
      if (file.size > 5_000_000) throw new Error('Use a file under 5 MB.');
      const data = file.name.toLowerCase().endsWith('.xlsx') ? readCommissionWorkbook(new Uint8Array(await file.arrayBuffer())) : [{ name: file.name, rows: parseStatementCsv(await file.text(), file.name.toLowerCase().endsWith('.tsv') ? '\t' : ',') }];
      if (data.some(s => s.rows.length < 2)) throw new Error('Each worksheet needs headers in row 1 and transaction rows. Remove empty worksheets.');
      setSheets(data); setSheet(0); setMapping(emptyImportMapping()); setStart(1);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not read statement.'); }
    finally { setBusy(false); }
  }
  return <CommissionPanel title="Import CSV / XLSX rows"><div className="commission-form-body">
    <p>Read the original CSV or XLSX attached above, then map the agency commission column. Imports create draft lines only; verify every policy match, settlement total, and eligibility decision before posting. Up to 20 rows can be reviewed per settlement allocation.</p>
    <button type="button" className="secondary" disabled={disabled || busy || !carrierId || !file || !/\.(csv|xlsx)$/i.test(file.name)} onClick={() => { if (file) void load(file); }}>Read attached statement</button>
    {busy && <p>Reading statement.</p>}{error && <p className="error-text" role="alert">{error}</p>}
    {rows && <>
      <label className="field">Worksheet<select value={sheet} onChange={e => { setSheet(Number(e.target.value)); setMapping(emptyImportMapping()); setStart(1); setReviewed(false); }}>{sheets.map((s, i) => <option key={i} value={i}>{s.name}</option>)}</select></label>
      <div className="form-grid">{([['policy','Policy number'],['reference','Carrier transaction reference'],['amount','Agency commission amount'],['effective','Policy effective date (YYYY-MM-DD, optional)'],['transaction','Transaction type (optional; defaults to receipt)']] as const).map(([key,label]) => <label className="field" key={key}>{label}<select value={mapping[key]} onChange={e => { setMapping(m => ({ ...m, [key]: Number(e.target.value) })); setReviewed(false); }}><option value={-1}>Choose column</option>{rows[0].map((name, i) => <option key={i} value={i}>{i + 1}: {name || '(blank)'}</option>)}</select></label>)}</div>
      <label className="field">First data row (1 is the row after headers)<input type="number" min={1} max={rows.length - 1} value={start} onChange={e => { setStart(Number(e.target.value)); setReviewed(false); }} /></label>
      <label className="field">Rows in this allocation<input type="number" min={1} max={20} value={count} onChange={e => { setCount(Number(e.target.value)); setReviewed(false); }} /></label>
      {mappingError && <p className="commission-notice">{mappingError}</p>}
      {preview && <><p className="commission-import-summary">{preview.lines.length} draft lines / ${(preview.totalCents / 100).toFixed(2)} agency commission / {preview.remainingRows} rows remain after this selection.</p>
        {[...preview.errors, ...preview.warnings].map((message, i) => <p className={preview!.errors.includes(message) ? "error-text" : "commission-notice"} role={preview!.errors.includes(message) ? 'alert' : undefined} key={i}>{message}</p>)}
        <div className="commission-scroll"><table><thead><tr><th>Source row</th><th>Reference</th><th>Policy match</th><th>Agency commission</th></tr></thead><tbody>{preview.lines.map(l => <tr key={l.sourceRow}><td>{l.sourceRow}</td><td>{l.lineRef}</td><td>{policies.find(p => p.id === l.policyId)?.policyNumber ?? 'Select manually'}</td><td>${(l.agencyCents / 100).toFixed(2)}</td></tr>)}</tbody></table></div>
        <label className="commission-check"><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)} /> I checked the mapping and will replace the current draft lines with these rows.</label>
        <button type="button" className="secondary" disabled={disabled || busy || !reviewed || !!preview.errors.length || !preview.lines.length} onClick={() => { apply(preview!.lines); setReviewed(false); }}>Use these draft lines</button>
      </>}
    </>}
  </div></CommissionPanel>;
}
