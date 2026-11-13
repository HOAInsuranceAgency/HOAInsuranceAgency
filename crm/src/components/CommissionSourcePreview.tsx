import { useEffect, useState } from 'react';
import { commissionAction } from '../lib/commissions';
import { useAsyncResource } from '../lib/useAsyncResource';
import { readCommissionWorkbook } from '../lib/commissionWorkbook';
import { parseStatementCsv } from '../../../shared/commissionImport';
import type { StatementIntake } from '../../../shared/commissionIntake';
export default function CommissionSourcePreview({ intake, onError }: { intake: StatementIntake; onError: (e: unknown) => void }) {
  const [shown, setShown] = useState(() => window.matchMedia?.('(min-width: 1200px)').matches ?? false);
  useEffect(()=>{
    const media=window.matchMedia?.('(min-width: 1200px)');
    if(!media)return;
    const resized=()=>setShown(media.matches);
    media.addEventListener('change',resized);
    return()=>media.removeEventListener('change',resized);
  },[]);
  const source = useAsyncResource(async () => {
    if (!shown) return null;
    try {
      const { url } = await commissionAction<{url:string}>('file', { key:intake.source });
      const ext = intake.filename.split('.').at(-1)?.toLowerCase();
      if (ext === 'csv' || ext === 'xlsx') {
        const response = await fetch(url);
        if (!response.ok) throw Error('Could not load original source. Try again.');
        const tables = ext === 'csv' ? [{ name: intake.filename, rows: parseStatementCsv(await response.text()) }] : readCommissionWorkbook(new Uint8Array(await response.arrayBuffer()));
        return { url, ext, tables };
      }
      return { url, ext, tables: undefined };
    } catch (error) { onError(error); throw error; }
  }, [intake.id, shown], { clearDataOnError: () => true });
  return <aside className="intake-original">
    <div className="commission-section-heading"><h3>Original document</h3><button className="secondary" onClick={() => setShown(v=>!v)}>{shown ? 'Hide original' : 'Show original'}</button></div>
    {shown && <><p className="small">Compare source values before confirming. {intake.filename}</p>
      {source.error && <p role="alert">{source.error}<button className="secondary" onClick={() => void source.refetch()}>Reload original</button></p>}
      {source.loading && <p role="status">Loading original…</p>}
      {source.data && (source.data.tables ? source.data.tables.map((table,i) => <details key={i} open={i===0}><summary>{table.name}</summary><div className="commission-scroll"><table><tbody>{table.rows.slice(0,200).map((r,j)=><tr key={j}>{r.map((cell,k)=><td key={k}>{cell}</td>)}</tr>)}</tbody></table></div>{table.rows.length>200 && <p>First 200 source rows shown. Open the original for the complete document.</p>}</details>) :
        source.data.ext === 'pdf' ? <iframe title="Original carrier statement" src={source.data.url} /> : <img src={source.data.url} alt="Original carrier statement" />)}
      {source.data && <a href={source.data.url} target="_blank" rel="noreferrer">Open complete original</a>}
    </>}
  </aside>;
}
