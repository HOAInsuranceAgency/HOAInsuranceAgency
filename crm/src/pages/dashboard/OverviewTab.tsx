import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  client,
  daysUntil,
  fmtDate,
  fmtMoney,
  listAllPages,
  type Account,
  type Policy,
  type Quote,
} from "../../lib/client";
import { isOpenQuoteStatus } from "../../lib/quoteStatus";
import { useAsyncResource } from "../../lib/useAsyncResource";
import { buildRenewalRows, receivables } from "../../lib/dashboardStats";
import { buildAttentionQueue, type AttentionItem } from "../../lib/attention";
import { TabFrame, Tile } from "./common";
import type { Schema } from "../../../amplify/data/resource";

type InvoiceRow = Schema["Invoice"]["type"];
type PfLoanRow = Schema["PfLoan"]["type"];
type TaskRow = Schema["MarketingTask"]["type"];
type DocumentRow = Schema["Document"]["type"];
type LicenseRow = Schema["License"]["type"];

/**
 * The landing tab: the counts, and the one list the whole rework exists
 * for — "Needs attention", every signal across the domains that means
 * someone should act today, ranked. Each row deep-links to the tab or
 * account where the work actually happens; this tab holds no workflows of
 * its own.
 */
interface OverviewData {
  leads: Account[];
  clients: Account[];
  /** All statuses — the attention queue's unmarketed rule needs the closed
   * ones too; the tile derives its open count client-side. */
  quotes: Quote[];
  policies: Policy[];
  tasks: TaskRow[];
  openInvoices: InvoiceRow[];
  pfLoans: PfLoanRow[];
  failedDocs: DocumentRow[];
  licenses: LicenseRow[];
}

const EMPTY: OverviewData = {
  leads: [],
  clients: [],
  quotes: [],
  policies: [],
  tasks: [],
  openInvoices: [],
  pfLoans: [],
  failedDocs: [],
  licenses: [],
};

export default function OverviewTab() {
  const navigate = useNavigate();

  const res = useAsyncResource<OverviewData>(
    async () => {
      const [
        leads,
        clients,
        quotes,
        policies,
        tasks,
        openInvoices,
        pfLoans,
        failedDocs,
        licenses,
      ] = await Promise.all([
        listAllPages((nextToken) =>
          client.models.Account.list({
            filter: { stage: { eq: "LEAD" } },
            nextToken,
          })
        ),
        listAllPages((nextToken) =>
          client.models.Account.list({
            filter: { stage: { eq: "CLIENT" } },
            nextToken,
          })
        ),
        listAllPages((nextToken) => client.models.Quote.list({ nextToken })),
        listAllPages((nextToken) => client.models.Policy.list({ nextToken })),
        listAllPages((nextToken) =>
          client.models.MarketingTask.list({ limit: 500, nextToken })
        ),
        listAllPages((nextToken) =>
          client.models.Invoice.list({
            filter: { or: [{ status: { eq: "SENT" } }, { status: { eq: "PROCESSING" } }] },
            nextToken,
          })
        ),
        listAllPages((nextToken) => client.models.PfLoan.list({ nextToken })),
        listAllPages((nextToken) =>
          client.models.Document.list({
            filter: { ocrStatus: { eq: "FAILED" } },
            nextToken,
          })
        ),
        listAllPages((nextToken) => client.models.License.list({ nextToken })),
      ]);
      return {
        leads,
        clients,
        quotes,
        policies,
        tasks: tasks as TaskRow[],
        openInvoices: openInvoices as InvoiceRow[],
        pfLoans: pfLoans as PfLoanRow[],
        failedDocs: failedDocs as DocumentRow[],
        licenses: licenses as LicenseRow[],
      };
    },
    [],
    { initialData: EMPTY, errorMessage: "Failed to load the overview" }
  );
  const d = res.data;

  const activePolicies = useMemo(
    () => d.policies.filter((p) => p.status === "ACTIVE").length,
    [d.policies]
  );
  const openQuotes = useMemo(
    () => d.quotes.filter((q) => isOpenQuoteStatus(q.status)).length,
    [d.quotes]
  );
  const ar = useMemo(
    () => receivables(d.openInvoices, d.pfLoans),
    [d.openInvoices, d.pfLoans]
  );
  const attention = useMemo(() => {
    const accountNames = new Map(
      [...d.leads, ...d.clients].map((a) => [a.id, a.name])
    );
    return buildAttentionQueue(
      {
        accountNames,
        quotes: d.quotes,
        invoices: d.openInvoices,
        loans: d.pfLoans,
        renewals: buildRenewalRows(d.leads, d.clients, d.policies, daysUntil),
        tasks: d.tasks,
        failedDocs: d.failedDocs,
        accountsWithFailedExtraction: [...d.leads, ...d.clients].filter(
          (a) => a.extractionStatus === "FAILED"
        ),
        licenses: d.licenses,
      },
      daysUntil,
      new Date()
    );
  }, [d]);

  return (
    <TabFrame res={res}>
      <div className="stat-row">
        <Tile n={d.leads.length} label="Open leads" onClick={() => navigate("/leads")} />
        <Tile n={d.clients.length} label="Clients" onClick={() => navigate("/clients")} />
        <Tile
          n={openQuotes}
          label="Quotes in flight"
          onClick={() => navigate("/quotes")}
        />
        <Tile
          n={activePolicies}
          label="Active policies"
          onClick={() => navigate("/policies")}
        />
        <Tile
          n={fmtMoney(ar.invoiceTotal + ar.loanTotal)}
          label="Accounts receivable"
          onClick={() => navigate("/?tab=finance")}
        />
        <Tile
          n={attention.length}
          label="Need attention"
          hot={attention.length > 0}
        />
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Needs attention</h2>
          <span className="muted small">ranked by severity, then age</span>
        </div>
        {attention.length === 0 ? (
          <p className="muted small">
            All quiet — nothing needs attention right now.
          </p>
        ) : (
          <ul className="attn">
            {attention.map((item, i) => {
              const p = present(item);
              return (
                // The queue is this tab's primary interactive surface, so
                // its rows keep the same keyboard contract as the tiles.
                <li
                  key={i}
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(p.target)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      navigate(p.target);
                    }
                  }}
                >
                  <span className={`stripe ${item.severity}`} />
                  <div className="what">
                    <div>
                      <strong>{p.strong}</strong>
                      {p.rest}
                    </div>
                    <div className="d">{p.detail}</div>
                  </div>
                  <span className="go">{p.label}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </TabFrame>
  );
}

/** The words and the destination for one attention item. Selection and
 * ranking live in lib/attention.ts; this is presentation only. */
function present(item: AttentionItem): {
  strong: string;
  rest: string;
  detail: string;
  target: string;
  label: string;
} {
  switch (item.kind) {
    case "invoice-overdue":
      return {
        strong: `Invoice ${item.invoiceNumber ?? "—"} overdue ${item.overdueDays}d`,
        rest: ` — ${item.accountName}${
          item.amount != null
            ? ` · ${fmtMoney(item.amount)} billed & uncollected`
            : " · amount not stored"
        }`,
        detail: `Due ${fmtDate(item.dueAt)}`,
        target: "/?tab=finance",
        label: "Finance →",
      };
    case "loan-defaulted":
      return {
        strong: "PF loan in default",
        rest: ` — ${item.accountName} · ${fmtMoney(item.outstanding)} outstanding${
          item.failedInstallment != null
            ? `, installment ${item.failedInstallment} missed`
            : ""
        }`,
        detail: item.defaultedAt
          ? `Defaulted ${fmtDate(item.defaultedAt.slice(0, 10))} · autopay standing down`
          : "Autopay standing down",
        target: "/?tab=finance",
        label: "Finance →",
      };
    case "renewal-unmarketed":
      return {
        strong:
          item.days < 0
            ? `Renewal ${-item.days}d overdue, marketing never started`
            : `Renewal in ${item.days}d, marketing not started`,
        rest: ` — ${item.accountName}${
          item.premium != null ? ` · ${fmtMoney(item.premium)} expiring` : ""
        }`,
        detail: "No marketing tasks or quotes found for this expiration",
        target: "/?tab=renewals",
        label: "Renewals →",
      };
    case "task-window-missed":
      return {
        strong: `Submission window missed ${item.daysPast}d ago`,
        rest: ` — ${item.accountName} / ${item.carrierName}`,
        detail: "Marketing task open past its submit-by",
        target: "/?tab=renewals",
        label: "Renewals →",
      };
    case "extraction-failed":
      return {
        // Two different pipelines fail here, and the words must not blur
        // them: a document's Textract OCR vs the account's AI extraction.
        strong:
          item.pipeline === "ocr" ? "Document OCR failed" : "AI extraction failed",
        rest: ` — ${item.accountName}${
          item.documentName ? ` · ${item.documentName}` : ""
        }`,
        detail: "Retry from the account's Documents tab",
        target: `/accounts/${item.accountId}?tab=documents`,
        label: "Account →",
      };
    case "election-pending":
      return {
        strong: `Finance election pending${
          item.pendingDays != null ? ` ${item.pendingDays}d` : ""
        }`,
        rest: ` — ${item.accountName}`,
        detail:
          item.expiresInDays != null
            ? `Offer expires in ${item.expiresInDays} ${item.expiresInDays === 1 ? "day" : "days"}`
            : "Offer sent · no election yet",
        target: "/?tab=finance",
        label: "Finance →",
      };
    case "license-expiring":
      return {
        strong:
          item.days < 0
            ? `${item.holder} license expired ${-item.days}d ago`
            : `${item.holder} license expires in ${item.days}d`,
        rest: ` — ${item.state}`,
        detail: "Manage under Settings → Licensing",
        target: "/settings?tab=licensing",
        label: "Settings →",
      };
  }
}
