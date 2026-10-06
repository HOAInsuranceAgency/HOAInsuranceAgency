import { ReportDownload } from "../../components/ReportDownload";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  daysUntil,
  fmtDate,
  fmtMoney,
} from "../../lib/client";
import { Badge, statusBadge, INVOICE_STATUS_BADGE } from "../../lib/badges";
import { useSort, SortTh } from "../../lib/useSort";
import { useAsyncResource } from "../../lib/useAsyncResource";
import { isAuthorizationError } from "../../lib/authorizationError";
import {
  invoiceAging,
  type AgingBucket,
} from "../../lib/dashboardStats";
import { localToday, TabFrame, Tile } from "./common";
import type { CommercialData } from "../../lib/commercial";
import type { ReportAccount } from "../../lib/dashboardAssignments";
import { loadFinanceDashboard, type FinancePaymentReceipt, type FinancePolicyAnchor, type FinanceLineAnchor } from "../../lib/dashboardFinanceLoad";
import { salespersonKey, salespersonSeries } from "../../lib/dashboardPeople";
import { interestIncomeBySalesperson, hasFinancingReceivable, nonBilledReceivables, outstandingPrincipal } from "../../lib/dashboardFinance";
import { StackedBars } from "../../components/StackedBars";
import type { Schema } from "../../../amplify/data/resource";

type InvoiceRow = Schema["Invoice"]["type"];
type PfLoanRow = Schema["PfLoan"]["type"];

interface FinanceData {
  invoices: InvoiceRow[];
  pfLoans: PfLoanRow[];
  accounts: ReportAccount[];
  payments: FinancePaymentReceipt[];
  policies: FinancePolicyAnchor[];
  invoiceLines: FinanceLineAnchor[];
  commercial: CommercialData;
  asOf: Date;
}

const EMPTY: FinanceData = {
  invoices: [], pfLoans: [], accounts: [], payments: [], policies: [], invoiceLines: [],
  commercial: { entries: {}, team: [] }, asOf: new Date(),
};

export default function FinanceTab() {
  const navigate = useNavigate();

  const res = useAsyncResource<FinanceData>(
    loadFinanceDashboard,
    [],
    { initialData: EMPTY, errorMessage: "Failed to load the finance view", clearDataOnError: isAuthorizationError }
  );
  const { invoices, pfLoans, accounts, payments, policies, invoiceLines, commercial, asOf } = res.data;

  const accountName = useMemo(
    () => new Map(accounts.map((a) => [a.id, a.name])),
    [accounts]
  );
  const open = useMemo(
    () => invoices.filter((i) => i.status === "SENT" || i.status === "PROCESSING"),
    [invoices]
  );
  const nonBilled = useMemo(() => nonBilledReceivables(pfLoans, invoices, policies, invoiceLines), [pfLoans, invoices, policies, invoiceLines]);
  const aging = useMemo(() => invoiceAging(open, daysUntil), [open]);
  const billed = aging.current.total + aging.d1to30.total + aging.d31to60.total + aging.d60plus.total;
  const series = useMemo(() => salespersonSeries(commercial), [commercial]);
  const interest = useMemo(() => interestIncomeBySalesperson(payments, commercial.entries, series, asOf), [payments, commercial, series, asOf]);
  const salespersonNames = useMemo(() => new Map(series.map(person => [person.key, person.label])), [series]);
  const salespersonName = (accountId: string) => salespersonNames.get(salespersonKey(accountId, commercial.entries)) ?? "Unassigned";
  const today = localToday();
  const overlapLoans = new Set(nonBilled.overlaps.map(overlap => overlap.loanId));
  const nonBilledIncomplete = nonBilled.unknown > 0 || nonBilled.overlaps.length > 0;
  const overlapPrincipal = pfLoans.filter(loan => overlapLoans.has(loan.id)).reduce((sum, loan) => sum + (outstandingPrincipal(loan) ?? 0), 0);
  const overlapUnknown = pfLoans.filter(loan => overlapLoans.has(loan.id) && outstandingPrincipal(loan) == null).length;
  const nonBilledNote = "Remaining financed principal with no open invoice, including cancelled coverage awaiting refund reconciliation. Installments are collected directly on the loan schedule. Future interest is excluded.";
  const gapNote = nonBilledIncomplete
    ? `Non-billed total is incomplete: ${nonBilled.overlaps.length} financing records (${fmtMoney(overlapPrincipal)} in known principal${overlapUnknown ? `; ${overlapUnknown} without a known balance` : ""}) share open billing and are excluded until reconciled; ${nonBilled.unknown} other financing records have no reliable balance.`
    : "";

  // Open invoices, most overdue first.
  const openRows = useMemo(
    () =>
      open.map((i) => ({
        id: i.id,
        accountId: i.accountId,
        number: i.number ?? null,
        account: accountName.get(i.accountId) ?? "—",
        amount:
          typeof i.stripeLinkAmountCents === "number"
            ? i.stripeLinkAmountCents / 100
            : null,
        dueAt: i.dueAt ?? null,
        days: i.dueAt ? daysUntil(i.dueAt) : null,
        status: i.status,
      })),
    [open, accountName]
  );
  const { sorted, sortKey, dir, toggle } = useSort(
    openRows,
    {
      number: (row) => row.number,
      account: (row) => row.account,
      amount: (row) => row.amount,
      due: (row) => row.dueAt,
      status: (row) => row.status,
    },
    "due"
  );

  return (
    <TabFrame res={res} hasSnapshot={res.data !== EMPTY}>
      <div className="report-actions"><ReportDownload report={{ title: "Finance summary", filters: `Snapshot as of ${today}. ${nonBilledNote} ${gapNote}`, sections: [{ title: "Finance summary", columns: ["Measure", "Amount (USD)", "Count"], rows: [
        [nonBilledIncomplete ? "Known non-billed principal (incomplete)" : "Total non-billed principal", nonBilled.total, nonBilled.count],
        ["Total billed and uncollected", billed, open.length],
        ["Billed invoices without stored amounts", null, aging.unpriced],
        ["Overdue billed invoices", aging.overdueTotal, aging.overdueCount],
        ["Financing overlapping open billing (excluded)", overlapPrincipal, nonBilled.overlaps.length],
        ["Financing without reliable balances (excluded)", null, nonBilled.unknown + overlapUnknown],
      ] }] }} /></div>
      <div className="stat-row">
        <Tile n={fmtMoney(nonBilled.total)} label={nonBilledIncomplete ? "A/R · Known non-billed (incomplete)" : "A/R · Total non-billed"} />
        <Tile n={fmtMoney(billed)} label={`A/R · ${aging.unpriced ? "Known billed" : "Total billed"} · ${open.length} ${open.length === 1 ? "invoice" : "invoices"}`} />
        <Tile n={fmtMoney(aging.overdueTotal)} label={`Overdue · ${aging.overdueCount} ${aging.overdueCount === 1 ? "invoice" : "invoices"}`} hot={aging.overdueCount > 0} />
      </div>
      <p className="muted small">{nonBilledNote}</p>
      {gapNote && <p className="error-text small" role="status">{gapNote}</p>}

      <div className="card">
        <div className="card-head">
          <h2>A/R aging</h2>
          <ReportDownload report={{ title: "A/R aging", filters: `Open invoices only · sorted by ${sortKey} (${dir}) · ${aging.unpriced} without stored amounts`, sections: [
            { title: "Aging totals", columns: ["Age", "Amount (USD)", "Invoice count"], rows: [["Total billed and uncollected", billed, open.length], ["Current", aging.current.total, aging.current.count], ["1–30 days", aging.d1to30.total, aging.d1to30.count], ["31–60 days", aging.d31to60.total, aging.d31to60.count], ["Over 60 days", aging.d60plus.total, aging.d60plus.count]] },
            { title: "Open invoices", columns: ["Invoice", "Account", "Amount (USD)", "Due", "Days until due", "Status"], rows: sorted.map(row => [row.number, row.account, row.amount, row.dueAt, row.days, row.status]) }
          ] }} />
          <span className="muted small">{aging.unpriced ? "Known billed" : "Total billed"}: {fmtMoney(billed)} · outstanding invoices by due date</span>
        </div>
        {open.length === 0 ? (
          <p className="muted small">No open invoices — nothing billed is waiting.</p>
        ) : (
          <>
            <AgingBar aging={{
              Current: aging.current,
              "1–30d": aging.d1to30,
              "31–60d": aging.d31to60,
              "60d+": aging.d60plus,
            }} />
            {aging.unpriced > 0 && (
              <p className="muted small">
                {aging.unpriced} open{" "}
                {aging.unpriced === 1 ? "invoice carries" : "invoices carry"} no
                stored amount and {aging.unpriced === 1 ? "is" : "are"} not in
                the totals.
              </p>
            )}
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <SortTh label="Invoice" colKey="number" sortKey={sortKey} dir={dir} onToggle={toggle} />
                    <SortTh label="Account" colKey="account" sortKey={sortKey} dir={dir} onToggle={toggle} />
                    <SortTh label="Amount" colKey="amount" sortKey={sortKey} dir={dir} onToggle={toggle} />
                    <SortTh label="Due" colKey="due" sortKey={sortKey} dir={dir} onToggle={toggle} />
                    <th></th>
                    <SortTh label="Status" colKey="status" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((row) => (
                    <tr
                      key={row.id}
                      className="clickable"
                      onClick={() => navigate(`/accounts/${row.accountId}?tab=invoices`)}
                    >
                      <td>{row.number ?? "—"}</td>
                      <td>
                        <strong>{row.account}</strong>
                      </td>
                      <td>{row.amount == null ? "—" : fmtMoney(row.amount)}</td>
                      <td>{fmtDate(row.dueAt ?? undefined)}</td>
                      <td className="days-badge">
                        {row.days != null &&
                          (row.days < 0 ? (
                            <Badge cls="red" label={`${-row.days}d overdue`} />
                          ) : (
                            <Badge cls="gray" label={`in ${row.days}d`} />
                          ))}
                      </td>
                      <td>
                        <Badge {...statusBadge(INVOICE_STATUS_BADGE, row.status)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Interest income by salesperson</h2>
          <ReportDownload report={{ title: "Interest income by salesperson", filters: `Posted receipts in the 30 days through ${asOf.toISOString()}; current salesperson assignment; ${interest.unknown} receipts without an interest amount`, sections: [{ title: "Interest income", columns: ["Salesperson", "Interest income (USD)"], rows: interest.rows.map(row => [row.label, row.values[row.key] ?? 0]) }] }} />
          <span className="muted small">Last 30 days · received interest · {fmtMoney(interest.total)}</span>
        </div>
        <StackedBars label="Interest income by salesperson" rows={interest.rows} series={series} formatValue={fmtMoney} />
        <p className="muted small">Based on posted financing payments and each account’s current salesperson assignment.</p>
        {interest.unknown > 0 && <p className="error-text small">{interest.unknown} receipts have no interest amount and are excluded from this total.</p>}
      </div>
      <PortfolioCard loans={pfLoans} accountName={accountName} salespersonName={salespersonName} overlapLoans={overlapLoans} />
    </TabFrame>
  );
}

/** Labels stay outside segments so small balances remain readable on phones. */
function AgingBar({ aging }: { aging: Record<string, AgingBucket> }) {
  const classes = ["a0", "a1", "a2", "a3"];
  const entries = Object.entries(aging);
  if (entries.every(([, b]) => b.count === 0)) return null;
  return (
    <>
    <div className="aging" aria-hidden="true">
      {entries.map(([label, b], i) =>
        b.total <= 0 ? null : (
          <div key={label} className={classes[i]} style={{ flex: b.total }} title={`${label}: ${fmtMoney(b.total)}`} />
        )
      )}
    </div>
    <dl className="aging-legend">{entries.map(([label, bucket]) => <div key={label}><dt>{label}</dt><dd>{fmtMoney(bucket.total)} <span className="muted small">· {bucket.count} {bucket.count === 1 ? 'invoice' : 'invoices'}</span></dd></div>)}</dl>
    </>
  );
}

function PortfolioCard({
  loans,
  accountName,
  salespersonName,
  overlapLoans,
}: {
  loans: PfLoanRow[];
  accountName: ReadonlyMap<string, string>;
  salespersonName: (accountId: string) => string;
  overlapLoans: ReadonlySet<string>;
}) {
  const navigate = useNavigate();
  const count = (s: string) => loans.filter((l) => l.status === s).length;

  const rows = loans
    .filter((l) => hasFinancingReceivable(l) && (l.status !== "CANCELLED" || outstandingPrincipal(l) !== 0))
    .sort((a, b) => (a.nextDueAt ?? "9999").localeCompare(b.nextDueAt ?? "9999"));

  return (
    <div className="card">
      <div className="card-head"><h2>Premium finance portfolio</h2>
      <ReportDownload report={{ title: "Premium finance portfolio", filters: "Outstanding financing, including funded cancellations awaiting reconciliation; sorted by next due date", sections: [
        { title: "Loan counts", columns: ["Status", "Count"], rows: [...(["ACTIVE", "ACCEPTED", "DEFAULTED", "QUOTED"].map(status => [status, count(status)])), ["Awaiting refund/reconciliation", rows.filter(loan => loan.status === "CANCELLED").length]] },
        { title: "Outstanding financing", columns: ["Account", "Salesperson", "Balance (USD)", "Next due / expected refund", "Status", "Open billing overlap", "Autopay"], rows: rows.map(l => [accountName.get(l.accountId) ?? "—", salespersonName(l.accountId), outstandingPrincipal(l), l.status === "CANCELLED" ? l.expectedCarrierRefundAt : l.nextDueAt, l.status === "CANCELLED" ? "Awaiting refund/reconciliation" : l.status, overlapLoans.has(l.id) ? "Review needed; excluded from non-billed A/R" : "None", l.status === "CANCELLED" ? "Stopped" : l.autopayFailedInstallment != null ? `Failed · #${l.autopayFailedInstallment}` : l.autopayPendingIntentId ? "Clearing" : l.stripePaymentMethodId ? "On" : "Off"]) }
      ] }} /></div>
      <div className="chip-row" style={{ marginBottom: 10, flexWrap: "wrap" }}>
        <Badge cls="green" label={`Active · ${count("ACTIVE")}`} />
        <Badge cls="gray" label={`Accepted · ${count("ACCEPTED")}`} />
        <Badge cls="red" label={`Defaulted · ${count("DEFAULTED")}`} />
        <Badge cls="blue" label={`Quoted · ${count("QUOTED")}`} />
        {rows.some(loan => loan.status === "CANCELLED") && <Badge cls="amber" label={`Awaiting reconciliation · ${rows.filter(loan => loan.status === "CANCELLED").length}`} />}
      </div>
      {rows.length === 0 ? (
        <p className="muted small">No outstanding financing.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th>Salesperson</th>
                <th>Balance</th>
                <th>Next due / refund</th>
                <th>Status</th>
                <th>Autopay</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr
                  key={l.id}
                  className="clickable"
                  onClick={() => navigate(`/accounts/${l.accountId}?tab=financing`)}
                >
                  <td>
                    <strong>{accountName.get(l.accountId) ?? "—"}</strong>
                  </td>
                  <td>{salespersonName(l.accountId)}</td>
                  <td>{outstandingPrincipal(l) == null ? "—" : fmtMoney(outstandingPrincipal(l)!)}
                    {overlapLoans.has(l.id) && <div><Badge cls="amber" label="Open bill · review needed" /></div>}
                  </td>
                  <td>{fmtDate((l.status === "CANCELLED" ? l.expectedCarrierRefundAt : l.nextDueAt) ?? undefined)}</td>
                  <td>{l.status === "CANCELLED" ? "Awaiting refund / reconciliation" : l.status.toLowerCase()}</td>
                  <td>
                    <AutopayBadge loan={l} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Autopay health, worst news first: a failed debit outranks one clearing,
 * which outranks the mandate merely existing. */
function AutopayBadge({ loan }: { loan: PfLoanRow }) {
  if (loan.status === "CANCELLED") return <Badge cls="gray" label="Stopped" />;
  if (loan.autopayFailedInstallment != null) {
    return <Badge cls="red" label={`Failed · #${loan.autopayFailedInstallment}`} />;
  }
  if (loan.autopayPendingIntentId) return <Badge cls="amber" label="Clearing" />;
  if (loan.stripePaymentMethodId) return <Badge cls="green" label="On" />;
  return <Badge cls="gray" label="Off" />;
}
