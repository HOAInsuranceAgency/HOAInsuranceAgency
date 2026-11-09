import type { Account, Contact, Invoice, InvoiceLine, Policy, Quote } from '../../lib/client';
export type InvoiceEditorProps = {
  invoice: Invoice;
  /** The account's policies, so the invoice can say which one it bills. */
  policies: Policy[];
  /** The account's quotes — a W8 invoice may bill one before bind. */
  quotes: Quote[];
  /** The account row: the financing hint reads its state and incorporation. */
  account: Account | null;
  /** The account's contacts — who the invoice can be addressed to. */
  contacts: Contact[];
  onChange: (next: Invoice) => void;
  /** Lifted so the summary table's totals move with the lines edited here. */
  onLinesChange: (invoiceId: string, lines: InvoiceLine[]) => void;
  onDeleted: () => void;
  onBusyChange?: (busy: boolean) => void;
  onGroupedRestored?: () => Promise<void>;
};
