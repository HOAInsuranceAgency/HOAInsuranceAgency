import { client, fmtMoney, listAllPages } from "../../lib/client";
import { useAsyncResource } from "../../lib/useAsyncResource";
import { receivables, type Receivables } from "../../lib/dashboardStats";
import { TabFrame } from "./common";
import type { Schema } from "../../../amplify/data/resource";

type PfLoanRow = Schema["PfLoan"]["type"];
type InvoiceRow = Schema["Invoice"]["type"];

interface FinanceData {
  /** SENT + PROCESSING only — the A/R slice, org-wide. */
  openInvoices: InvoiceRow[];
  pfLoans: PfLoanRow[];
}

const EMPTY: FinanceData = { openInvoices: [], pfLoans: [] };

export default function FinanceTab() {
  const res = useAsyncResource<FinanceData>(
    async () => {
      const [openInvoices, pfLoans] = await Promise.all([
        // The A/R slice: money billed and not yet collected.
        listAllPages((nextToken) =>
          client.models.Invoice.list({
            filter: { or: [{ status: { eq: "SENT" } }, { status: { eq: "PROCESSING" } }] },
            nextToken,
          })
        ),
        listAllPages((nextToken) => client.models.PfLoan.list({ nextToken })),
      ]);
      return {
        openInvoices: openInvoices as InvoiceRow[],
        pfLoans: pfLoans as PfLoanRow[],
      };
    },
    [],
    { initialData: EMPTY, errorMessage: "Failed to load the finance view" }
  );

  return (
    <TabFrame res={res}>
      <ReceivablesCard r={receivables(res.data.openInvoices, res.data.pfLoans)} />
    </TabFrame>
  );
}

/**
 * What the world owes the agency right now — two honest buckets, no netting:
 * invoices the association was asked to pay and hasn't, and financed
 * principal outstanding on loans money has touched.
 */
function ReceivablesCard({ r }: { r: Receivables }) {
  return (
    <div className="card">
      <h2>Accounts receivable</h2>
      <div className="stat-row">
        <div className="stat">
          <div className="n">{fmtMoney(r.invoiceTotal)}</div>
          <div className="l">
            Billed &amp; uncollected · {r.invoiceCount}{" "}
            {r.invoiceCount === 1 ? "invoice" : "invoices"}
          </div>
        </div>
        <div className="stat">
          <div className="n">{fmtMoney(r.loanTotal)}</div>
          <div className="l">
            Financed principal outstanding · {r.loanCount}{" "}
            {r.loanCount === 1 ? "loan" : "loans"}
          </div>
        </div>
        <div className="stat">
          <div className="n">{fmtMoney(r.invoiceTotal + r.loanTotal)}</div>
          <div className="l">Total receivable</div>
        </div>
      </div>
      {r.invoiceUnpriced > 0 && (
        <p className="muted small">
          {r.invoiceUnpriced} open{" "}
          {r.invoiceUnpriced === 1 ? "invoice carries" : "invoices carry"} no
          stored amount and {r.invoiceUnpriced === 1 ? "is" : "are"} not in the
          total — open {r.invoiceUnpriced === 1 ? "it" : "them"} from the
          account to see the figure.
        </p>
      )}
    </div>
  );
}
