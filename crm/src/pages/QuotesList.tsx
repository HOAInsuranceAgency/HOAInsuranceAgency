import { Breadcrumb, Pagination } from "../components/ui/kit";
import { useListPage } from "../lib/useListPage";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  client,
  fmtDate,
  fmtMoney,
  listAllPages,
  type Account,
  type Carrier,
  type Quote,
} from "../lib/client";
import { Badge, statusBadge, QUOTE_STATUS_BADGE } from "../lib/badges";
import { useSort, SortTh } from "../lib/useSort";
import { isOpenQuoteStatus } from "../lib/quoteStatus";
import { useAsyncResource } from "../lib/useAsyncResource";

export default function QuotesList() {
  const [openOnly, setOpenOnly] = useState(true);
  const [query, setQuery] = useState("");

  // Paginated: a bare .list() returns one ~100-row page and stops — this
  // list must not show fewer quotes than the dashboard tile that links here.
  const quoteRes = useAsyncResource(
    async () =>
      listAllPages((nextToken) => client.models.Quote.list({ nextToken })),
    [],
    { initialData: [] as Quote[], errorMessage: "Failed to load quotes" }
  );
  const quotes = quoteRes.data;

  // Name lookups. Surfaced rather than ignored for the same reason as
  // PoliciesList: a missing name renders "—", which reads as data, not failure.
  const accountRes = useAsyncResource(
    async () =>
      listAllPages((nextToken) => client.models.Account.list({ nextToken })),
    [],
    { initialData: [] as Account[], errorMessage: "Failed to load account names" }
  );
  const accounts = accountRes.data;

  const carrierRes = useAsyncResource(
    async () =>
      listAllPages((nextToken) => client.models.Carrier.list({ nextToken })),
    [],
    { initialData: [] as Carrier[], errorMessage: "Failed to load carrier names" }
  );
  const carriers = carrierRes.data;

  const accountName = useMemo(
    () => new Map(accounts.map((a) => [a.id, a.name])),
    [accounts]
  );
  const carrierName = useMemo(
    () => new Map(carriers.map((c) => [c.id, c.name])),
    [carriers]
  );

  const visible = openOnly
    ? quotes.filter((q) => isOpenQuoteStatus(q.status))
    : quotes;

  const { sorted, sortKey, dir, toggle } = useSort(
    visible.filter(q => [accountName.get(q.accountId), carrierName.get(q.carrierId ?? ""), ...(q.lines ?? [])].join(" ").toLowerCase().includes(query.toLowerCase())),
    {
      account: (q) => accountName.get(q.accountId) ?? "",
      carrier: (q) => (q.carrierId ? carrierName.get(q.carrierId) ?? "" : null),
      premium: (q) => q.premium,
      effective: (q) => q.effectiveDate,
      status: (q) => q.status,
    },
    "account"
  );

  const page = useListPage(sorted, `${query}:${openOnly}:${sortKey}:${dir}`);
  return (
    <>
      <Breadcrumb to="/leads">Accounts</Breadcrumb>
      <h1>Quotes</h1>
      <p className="sub">All quotes across leads and clients</p>

      <div className="toolbar">
        <div className="chip-row">
          <button className={openOnly ? "on" : ""} onClick={() => setOpenOnly(true)}>
            In flight
          </button>
          <button className={!openOnly ? "on" : ""} onClick={() => setOpenOnly(false)}>
            All
          </button>
        </div>
      </div>

      <div className="toolbar"><label className="field">Find quotes<input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Account, carrier, coverage" /></label></div>
      {accountRes.error && <p className="error-text">{accountRes.error}</p>}
      {carrierRes.error && <p className="error-text">{carrierRes.error}</p>}

      <div className="card">
        {!quoteRes.loaded ? (
          <p className="muted small">Loading…</p>
        ) : quoteRes.error ? (
          <p className="error-text">{quoteRes.error}</p>
        ) : sorted.length === 0 ? (
          <p className="muted small">No quotes.</p>
        ) : (
          <div className="table-wrap">
            <table className="stacked-table">
              <thead>
                <tr>
                  <SortTh label="Account" colKey="account" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Carrier" colKey="carrier" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Premium" colKey="premium" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Effective" colKey="effective" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Status" colKey="status" sortKey={sortKey} dir={dir} onToggle={toggle} />
                </tr>
              </thead>
              <tbody>
                {page.rows.map((q) => (
                  <tr key={q.id}>
                    <td data-label="Account">
                      <Link to={`/accounts/${q.accountId}?tab=quotes&record=${q.id}#quote-${q.id}`}>{accountName.get(q.accountId) ?? "Account"}</Link>
                    </td>
                    <td data-label="Carrier">{q.carrierId ? carrierName.get(q.carrierId) ?? "—" : "—"}</td>
                    <td data-label="Premium">{fmtMoney(q.premium)}</td>
                    <td data-label="Effective">{fmtDate(q.effectiveDate)}</td>
                    <td data-label="Status">
                      <Badge {...statusBadge(QUOTE_STATUS_BADGE, q.status)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination total={sorted.length} page={page.page} onPage={page.setPage} noun="quotes" />
          </div>
        )}
      </div>
    </>
  );
}
