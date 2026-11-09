import { Button } from "../../components/ui/Button";
import { GroupedFinancePreview } from './GroupedFinancePreview';
import { InvoiceDelivery } from './InvoiceDelivery';
import { InvoiceDetails } from './InvoiceDetails';
import { InvoiceHeader } from './InvoiceHeader';
import { InvoiceLinesTable } from './InvoiceLinesTable';
import type { InvoiceEditorProps } from './types';
import { useInvoiceEditor } from './useInvoiceEditor';
export function InvoiceEditor(props: InvoiceEditorProps) { return <InvoiceEditorContent key={props.invoice.id} {...props} />; }
function InvoiceEditorContent(props: InvoiceEditorProps) {
  const editor = useInvoiceEditor(props);
  const { linesRes } = editor;

  if (!linesRes.loaded) return <p className="muted small">Loading invoice…</p>;
  if (linesRes.error) return <p className="error-text">{linesRes.error} <Button type="button" disabled={linesRes.loading} onClick={() => void linesRes.refetch()}>Retry invoice lines</Button></p>;

  return (
    <div className="card invoice">
      <InvoiceHeader editor={editor} />

      <InvoiceLinesTable editor={editor} />

      <InvoiceDetails editor={editor} />

      {editor.grouped ? <GroupedFinancePreview invoice={editor.invoice} account={editor.account}
        policies={editor.groupedPolicies} lines={editor.lines} /> : <InvoiceDelivery editor={editor} />}
    </div>
  );
}
export default InvoiceEditor;
