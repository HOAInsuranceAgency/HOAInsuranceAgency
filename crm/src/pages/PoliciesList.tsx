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
  type Policy,
} from "../lib/client";
import { Badge, statusBadge, POLICY_STATUS_BADGE } from "../lib/badges";
import { useSort, SortTh } from "../lib/useSort";
import { useAsyncResource } from "../lib/useAsyncResource";

export default function PoliciesList() {
  const [query, setQuery] = useState("");
  const [activeOnly, setActiveOnly] = useState(true);

  // Paginated: a bare .list() returns one ~100-row page and stops, so this
  // page could show fewer policies than the dashboard tile that links to it
  // counts — a silent cap that reads as data, not truncation.
  const policyRes = useAsyncResource(
    async () =>
      listAllPages((nextToken) => client.models.Policy.list({ nextToken })),
    [],
    { initialData: [] as Policy[], errorMessage: "Failed to load policies" }
  );
  const policies = policyRes.data;

  // Name lookups, separate hooks with [] deps so they are read once. Their
  // errors are surfaced rather than ignored: without them every row's account
  // and carrier cell falls back to "—", which reads as a policy with none set
  // rather than as a failed read.
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

  // Default: expiration ascending — next up (or already expired) first.
  const { sorted, sortKey, dir, toggle } = useSort(
    policies.filter(p => (!activeOnly || p.status === "ACTIVE") && [accountName.get(p.accountId), carrierName.get(p.carrierId ?? ""), p.policyNumber].join(" ").toLowerCase().includes(query.toLowerCase())),
    {
      account: (p) => accountName.get(p.accountId) ?? "",
      carrier: (p) => (p.carrierId ? carrierName.get(p.carrierId) ?? "" : null),
      number: (p) => p.policyNumber,
      premium: (p) => p.premium,
      effective: (p) => p.effectiveDate,
      expires: (p) => p.expirationDate,
      bound: (p) => p.datePolicyBound,
      status: (p) => p.status,
    },
    "expires"
  );

  const page = useListPage(sorted, `${query}:${activeOnly}:${sortKey}:${dir}`);
  return (
    <>
      <Breadcrumb to="/leads">Accounts</Breadcrumb>
      <h1>Policies</h1>
      <p className="sub">All bound policies — soonest expiration first</p>

      <div className="toolbar"><label className="field">Find policies<input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Account, carrier, policy number" /></label><label className="field">View<select value={activeOnly ? "active" : "all"} onChange={e => setActiveOnly(e.target.value === "active")}><option value="active">Active policies</option><option value="all">All policies & history</option></select></label></div>
      {accountRes.error && <p className="error-text">{accountRes.error}</p>}
      {carrierRes.error && <p className="error-text">{carrierRes.error}</p>}

      <div className="card">
        {!policyRes.loaded ? (
          <p className="muted small">Loading…</p>
        ) : policyRes.error ? (
          <p className="error-text">{policyRes.error}</p>
        ) : sorted.length === 0 ? (
          <p className="muted small">No policies bound yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="stacked-table">
              <thead>
                <tr>
                  <SortTh label="Account" colKey="account" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Carrier" colKey="carrier" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Policy #" colKey="number" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Premium" colKey="premium" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Effective" colKey="effective" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Expires" colKey="expires" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Bound" colKey="bound" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Status" colKey="status" sortKey={sortKey} dir={dir} onToggle={toggle} />
                </tr>
              </thead>
              <tbody>
                {page.rows.map((p) => (
                  <tr key={p.id}>
                    <td data-label="Account">
                      <Link to={`/accounts/${p.accountId}?tab=policies&record=${p.id}#policy-${p.id}`}>{accountName.get(p.accountId) ?? "Account"}</Link>
                    </td>
                    <td data-label="Carrier">{p.carrierId ? carrierName.get(p.carrierId) ?? "—" : "—"}</td>
                    <td data-label="Policy #">{p.policyNumber ?? "—"}</td>
                    <td data-label="Premium">{fmtMoney(p.premium)}</td>
                    <td data-label="Effective">{fmtDate(p.effectiveDate)}</td>
                    <td data-label="Expires">{fmtDate(p.expirationDate)}</td>
                    <td data-label="Bound">{fmtDate(p.datePolicyBound?.slice(0, 10))}</td>
                    <td data-label="Status">
                      <Badge {...statusBadge(POLICY_STATUS_BADGE, p.status)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination total={sorted.length} page={page.page} onPage={page.setPage} noun="policies" />
          </div>
        )}
      </div>
    </>
  );
}
