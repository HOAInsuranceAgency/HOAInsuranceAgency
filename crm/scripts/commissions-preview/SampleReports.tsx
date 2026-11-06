import { useEffect, useMemo } from 'react';
import { visibleSampleReports } from './sample-reports';
import './preview-reports.css';

export default function SampleReports({owner}:{owner:boolean}) {
  const files = useMemo(() => visibleSampleReports(owner).map(file => {
    const url = location.protocol === 'file:'
      ? URL.createObjectURL(new Blob([Uint8Array.from(atob(file.content), c=>c.charCodeAt(0))],{type:file.contentType}))
      : './reports/' + encodeURIComponent(file.filename);
    return {...file,url};
  }),[owner]);
  useEffect(()=>()=>{for(const file of files) if(file.url.startsWith('blob:')) URL.revokeObjectURL(file.url);},[files]);
  return <details className="preview-report-gallery">
    <summary><strong>Sample PDFs</strong><span>{files.length} watermarked review files</span></summary>
    <div className="preview-report-content">
      <p>Actual CRM report layouts with fictional data. Every page is marked <strong>TEST DATA — DO NOT PAY</strong>.</p>
      <p className="small muted">Each scenario is a separate example. November reports retain the approved $320; the $120 payment and $200 remaining balance stay in the payment history.</p>
      <div className="preview-report-table"><table>
        <thead><tr><th>Example</th><th>Document</th><th>Approved amount</th><th>Review</th></tr></thead>
        <tbody>{files.map(file=><tr key={file.id}>
          <td>{file.label}</td><td>{file.title}</td>
          <td>{file.totalCents === null ? 'Review only' : new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(file.totalCents/100)}</td>
          <td className="preview-report-actions"><a href={file.url} target="_blank" rel="noopener noreferrer" aria-label={'View PDF: '+file.label+' — '+file.title}>View PDF</a>
          <a href={file.url} download={file.filename} aria-label={'Download PDF: '+file.label+' — '+file.title}>Download</a></td>
        </tr>)}</tbody>
      </table></div>
      <p className="small muted">These review copies demonstrate the templates. They are not real approvals, archived company records, or proof of payment.</p>
    </div>
  </details>;
}
