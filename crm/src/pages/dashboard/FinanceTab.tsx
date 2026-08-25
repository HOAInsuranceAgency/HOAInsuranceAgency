import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  client,
  daysUntil,
  fmtDate,
  fmtMoney,
  listAllPages,
  type Account,
} from "../../lib/client";
import { Badge, statusBadge, INVOICE_STATUS_BADGE } from "../../lib/badges";
import { useSort, SortTh } from "../../lib/useSort";
import { useAsyncResource } from "../../lib/useAsyncResource";
import { usePremiumFinance } from "../../lib/premiumFinance/PfContext";
import {
  invoiceAging,
  pfInstallmentsDue,
  receivables,
  sumInWindow,
  type AgingBucket,
} from "../../lib/dashboardStats";
import { localToday, TabFrame, Tile } from "./common";
import type { Schema } from "../../../amplify/data/resource";

type InvoiceRow = Schema["Invoice"]["type"];
type PfLoanRow = Schema["PfLoan"]["type"];
type PfNoticeRow = Schema["PfNotice"]["type"];

/**
 * Where the money is right now. Top half is invoicing — aging by due date,
 * then the open bills themselves. Bottom half is the premium-finance
 * portfolio and everything in motion around it, shown when the PF module is
 * on (the same gate as the Financing nav item). Invoices are read once,
 * unfiltered, and split client-side: open for A/R, PAID for collected,
 * DRAFT for the unsent pile — three filtered reads of one table would cost
 * more than the table.
 */
interface FinanceData {
  invoices: InvoiceRow[];
  pfLoans: PfLoanRow[];
  accounts: Account[];
  notices: PfNoticeRow[];
}

const EMPTY: FinanceData = { invoices: [], pfLoans: [], accounts: [], notices: [] };

export default function FinanceTab() {
  const navigate = useNavigate();
  const pf = usePremiumFinance();

  const res = useAsyncResource<FinanceData>(
    async () => {
      const [invoices, pfLoans, accounts, notices] = await Promise.all([
        listAllPages((nextToken) => client.models.Invoice.list({ nextToken })),
        listAllPages((nextToken) => client.models.PfLoan.list({ nextToken })),
        listAllPages((nextToken) => client.models.Account.list({ nextToken })),
        listAllPages((nextToken) => client.models.PfNotice.list({ nextToken })),
      ]);
      return {
        invoices: invoices as InvoiceRow[],
        pfLoans: pfLoans as PfLoanRow[],
        accounts,
        notices: notices as PfNoticeRow[],
      };
    },
    [],
    { initialData: EMPTY, errorMessage: "Failed to load the finance view" }
  );
  const { invoices, pfLoans, accounts, notices } = res.data;

  const accountName = useMemo(
    () => new Map(accounts.map((a) => [a.id, a.name])),
    [accounts]
  );
  const open = useMemo(
    () => invoices.filter((i) => i.status === "SENT" || i.status === "PROCESSING"),
    [invoices]
  );
  const r = useMemo(() => receivables(open, pfLoans), [open, pfLoans]);
  const aging = useMemo(() => invoiceAging(open, daysUntil), [open]);

  const today = localToday();
  const collected = useMemo(
    () =>
      sumInWindow(
        invoices.filter((i) => i.status === "PAID"),
        (i) => i.paidAt,
        (i) => (i.stripeLinkAmountCents ?? 0) / 100,
        `${today.slice(0, 8)}01`,
        today
      ),
    [invoices, today]
  );

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
    <TabFrame res={res}>
      <div className="stat-row">
        <Tile n={fmtMoney(r.invoiceTotal + r.loanTotal)} label="Total receivable" />
        <Tile
          n={fmtMoney(r.invoiceTotal)}
          label={`Billed & uncollected · ${r.invoiceCount} ${r.invoiceCount === 1 ? "invoice" : "invoices"}`}
        />
        <Tile
          n={fmtMoney(aging.overdueTotal)}
          label={`Overdue · ${aging.overdueCount} ${aging.overdueCount === 1 ? "invoice" : "invoices"}`}
          hot={aging.overdueCount > 0}
        />
        <Tile
          n={fmtMoney(r.loanTotal)}
          label={`Financed outstanding · ${r.loanCount} ${r.loanCount === 1 ? "loan" : "loans"}`}
        />
        <Tile n={fmtMoney(collected.total)} label="Collected this month" />
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Invoice aging</h2>
          <span className="muted small">by due date, open invoices only</span>
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

      {pf.enabled && (
        <div className="cols">
          <PortfolioCard loans={pfLoans} accountName={accountName} />
          <InMotionCard
            loans={pfLoans}
            notices={notices}
            invoices={invoices}
            accountName={accountName}
          />
        </div>
      )}
    </TabFrame>
  );
}

/** The stacked aging bar: oldest money reddest, labels inside segments. */
function AgingBar({ aging }: { aging: Record<string, AgingBucket> }) {
  const classes = ["a0", "a1", "a2", "a3"];
  const entries = Object.entries(aging);
  if (entries.every(([, b]) => b.count === 0)) return null;
  return (
    <div className="aging">
      {entries.map(([label, b], i) =>
        b.count === 0 ? null : (
          <div key={label} className={classes[i]} style={{ flex: Math.max(b.total, 1) }}>
            {label} · {fmtMoney(b.total)}
          </div>
        )
      )}
    </div>
  );
}

const LIVE_LOAN_STATUSES: readonly string[] = ["ACCEPTED", "ACTIVE", "DEFAULTED"];

function PortfolioCard({
  loans,
  accountName,
}: {
  loans: PfLoanRow[];
  accountName: ReadonlyMap<string, string>;
}) {
  const navigate = useNavigate();
  const count = (s: string) => loans.filter((l) => l.status === s).length;

  const rows = loans
    .filter((l) => LIVE_LOAN_STATUSES.includes(l.status))
    .sort((a, b) => (a.nextDueAt ?? "9999").localeCompare(b.nextDueAt ?? "9999"));

  return (
    <div className="card">
      <h2>Premium finance portfolio</h2>
      <div className="chip-row" style={{ marginBottom: 10, flexWrap: "wrap" }}>
        <Badge cls="green" label={`Active · ${count("ACTIVE")}`} />
        <Badge cls="gray" label={`Accepted · ${count("ACCEPTED")}`} />
        <Badge cls="red" label={`Defaulted · ${count("DEFAULTED")}`} />
        <Badge cls="blue" label={`Quoted · ${count("QUOTED")}`} />
      </div>
      {rows.length === 0 ? (
        <p className="muted small">No live loans.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th>Balance</th>
                <th>Next due</th>
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
                  <td>{fmtMoney(l.balance ?? l.amountFinanced)}</td>
                  <td>{fmtDate(l.nextDueAt ?? undefined)}</td>
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
  if (loan.autopayFailedInstallment != null) {
    return <Badge cls="red" label={`Failed · #${loan.autopayFailedInstallment}`} />;
  }
  if (loan.autopayPendingIntentId) return <Badge cls="amber" label="Clearing" />;
  if (loan.stripePaymentMethodId) return <Badge cls="green" label="On" />;
  return <Badge cls="gray" label="Off" />;
}

/**
 * Everything mid-flight around the portfolio: offers out, cancellation
 * clocks running, cash expected in, refunds owed back, and bills drafted
 * but never sent. Rendered even when a row is empty — "None outstanding"
 * is an answer, and a row that vanishes when quiet makes the card's shape
 * unreadable.
 */
function InMotionCard({
  loans,
  notices,
  invoices,
  accountName,
}: {
  loans: PfLoanRow[];
  notices: PfNoticeRow[];
  invoices: InvoiceRow[];
  accountName: ReadonlyMap<string, string>;
}) {
  const now = Date.now();
  const DAY = 86_400_000;

  const elections = loans.filter(
    (l) =>
      l.status === "QUOTED" &&
      l.electionToken &&
      !l.electedAt &&
      (!l.electionTokenExpiresAt || Date.parse(l.electionTokenExpiresAt) > now)
  );
  const oldestElectionDays = elections.length
    ? Math.max(
        ...elections.map((l) => Math.floor((now - Date.parse(l.quotedAt)) / DAY))
      )
    : null;

  const requested = new Set(
    notices.filter((n) => n.type === "CANCELLATION_REQUEST").map((n) => n.loanId)
  );
  // Episode-scoped, mirroring pf-servicing's own rule: a cure sets the loan
  // back to ACTIVE and clears defaultedAt, but the intent notice row is
  // immutable — its clock keeps "running" on paper. A clock only counts
  // while its loan is still DEFAULTED and the intent belongs to the
  // current default (occurredAt at or after defaultedAt), so a paid-up
  // loan stops showing a red countdown it has already escaped.
  const loanById = new Map(loans.map((l) => [l.id, l]));
  const clocks = notices
    .filter((n) => {
      if (n.type !== "INTENT_TO_CANCEL" || !n.clockExpiresAt) return false;
      if (Date.parse(n.clockExpiresAt) <= now || requested.has(n.loanId)) return false;
      const loan = loanById.get(n.loanId);
      return (
        loan?.status === "DEFAULTED" &&
        loan.defaultedAt != null &&
        n.occurredAt >= loan.defaultedAt
      );
    })
    .sort((a, b) => (a.clockExpiresAt ?? "").localeCompare(b.clockExpiresAt ?? ""));
  const soonestClockDays = clocks.length
    ? Math.ceil((Date.parse(clocks[0].clockExpiresAt as string) - now) / DAY)
    : null;

  const installments = pfInstallmentsDue(loans, daysUntil);

  const refunds = loans
    .filter((l) => {
      if (!l.expectedCarrierRefundAt) return false;
      const days = daysUntil(l.expectedCarrierRefundAt);
      return days != null && days >= 0;
    })
    .sort((a, b) =>
      (a.expectedCarrierRefundAt ?? "").localeCompare(b.expectedCarrierRefundAt ?? "")
    );

  const drafts = invoices.filter((i) => i.status === "DRAFT");
  const oldestDraftDays = drafts.length
    ? Math.max(
        ...drafts.map((i) => {
          const at = i.issuedAt ?? i.createdAt?.slice(0, 10);
          const days = at ? daysUntil(at) : null;
          return days == null ? 0 : Math.max(0, -days);
        })
      )
    : null;

  return (
    <div className="card">
      <h2>In motion</h2>
      <div className="table-wrap">
        <table>
          <tbody>
            <tr>
              <td>
                <strong>Pending elections</strong>
              </td>
              <td>
                {elections.length
                  ? `${elections.length} ${elections.length === 1 ? "offer" : "offers"} out`
                  : "None outstanding"}
              </td>
              <td>
                {oldestElectionDays != null ? (
                  <Badge cls="blue" label={`oldest ${oldestElectionDays}d`} />
                ) : (
                  <Badge cls="gray" label="—" />
                )}
              </td>
            </tr>
            <tr>
              <td>
                <strong>Cancellation clock</strong>
              </td>
              <td>
                {clocks.length
                  ? `${accountName.get(clocks[0].accountId) ?? "—"}${
                      clocks.length > 1 ? ` +${clocks.length - 1} more` : ""
                    }`
                  : "None running"}
              </td>
              <td>
                {soonestClockDays != null ? (
                  <Badge cls="red" label={`${soonestClockDays}d left`} />
                ) : (
                  <Badge cls="gray" label="—" />
                )}
              </td>
            </tr>
            <tr>
              <td>
                <strong>Expected installments · 30d</strong>
              </td>
              <td>
                {installments.count
                  ? `${installments.count} ${installments.count === 1 ? "debit" : "debits"}`
                  : "None due"}
              </td>
              <td>
                {installments.count ? (
                  <Badge cls="green" label={fmtMoney(installments.total)} />
                ) : (
                  <Badge cls="gray" label="—" />
                )}
              </td>
            </tr>
            <tr>
              <td>
                <strong>Carrier refund expected</strong>
              </td>
              <td>
                {refunds.length
                  ? `${refunds.length} ${refunds.length === 1 ? "loan" : "loans"}`
                  : "None expected"}
              </td>
              <td>
                {refunds.length ? (
                  <Badge
                    cls="gray"
                    label={`by ${fmtDate(refunds[0].expectedCarrierRefundAt ?? undefined)}`}
                  />
                ) : (
                  <Badge cls="gray" label="—" />
                )}
              </td>
            </tr>
            <tr>
              <td>
                <strong>Draft invoices unsent</strong>
              </td>
              <td>{drafts.length ? `${drafts.length} ${drafts.length === 1 ? "draft" : "drafts"}` : "None"}</td>
              <td>
                {oldestDraftDays != null ? (
                  <Badge cls="amber" label={`oldest ${oldestDraftDays}d`} />
                ) : (
                  <Badge cls="gray" label="—" />
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
