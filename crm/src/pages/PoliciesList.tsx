import { Button } from "../components/ui/Button";
import { Table } from "../components/ui/Table";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { client, fmtDate, fmtMoney, type Account, type Carrier, type Policy } from "../lib/client";
import { listAllPages } from "../../../shared/pagination";
import { Badge, statusBadge, POLICY_STATUS_BADGE } from "../lib/badges";
import { useSort, SortTh } from "../lib/useSort";
import { useAsyncResource } from "../lib/useAsyncResource";

export default function PoliciesList() {
  const navigate = useNavigate();

  // Paginated: a bare .list() returns one ~100-row page and stops, so this
  // page could show fewer policies than the dashboard tile that links to it
  // counts — a silent cap that reads as data, not truncation.
  const policyRes = useAsyncResource(
    async () =>
      listAllPages((nextToken) => client.models.Policy.list({ nextToken })),
    [],
    { initialData: [] as Policy[], errorMessage: "Failed to load policies" , live: true }
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
    { initialData: [] as Account[], errorMessage: "Failed to load account names" , live: true }
  );
  const accounts = accountRes.data;

  const carrierRes = useAsyncResource(
    async () =>
      listAllPages((nextToken) => client.models.Carrier.list({ nextToken })),
    [],
    { initialData: [] as Carrier[], errorMessage: "Failed to load carrier names" , live: true }
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
    policies,
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

  return (
    <>
      <h1>Policies</h1>
      <p className="sub">All bound policies — soonest expiration first</p>

      {accountRes.error && <p className="error-text" role="alert">{accountRes.error} <Button disabled={accountRes.loading} onClick={() => void accountRes.refetch()}>Retry account names</Button></p>}
      {carrierRes.error && <p className="error-text" role="alert">{carrierRes.error} <Button disabled={carrierRes.loading} onClick={() => void carrierRes.refetch()}>Retry carriers</Button></p>}

      <div className="card">
        {!policyRes.loaded ? (
          <p className="muted small">Loading…</p>
        ) : policyRes.error ? (
          <p className="error-text" role="alert">{policyRes.error} <Button disabled={policyRes.loading} onClick={() => void policyRes.refetch()}>Retry policies</Button></p>
        ) : sorted.length === 0 ? (
          <p className="muted small">No policies bound yet.</p>
        ) : (
          <div className="table-wrap">
            <Table>
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
                {sorted.map((p) => (
                  <tr
                    key={p.id}
                    className="clickable"
                    onClick={() => navigate(`/accounts/${p.accountId}?tab=policies`)}
                  >
                    <td>
                      <strong>{accountName.get(p.accountId) ?? "—"}</strong>
                    </td>
                    <td>{p.carrierId ? carrierName.get(p.carrierId) ?? "—" : "—"}</td>
                    <td>{p.policyNumber ?? "—"}</td>
                    <td>{fmtMoney(p.premium)}{(p.brokerFee ?? 0) > 0 && <div className="small muted">+ {fmtMoney(p.brokerFee)} broker fee</div>}</td>
                    <td>{fmtDate(p.effectiveDate)}</td>
                    <td>{fmtDate(p.expirationDate)}</td>
                    <td>{fmtDate(p.datePolicyBound?.slice(0, 10))}</td>
                    <td>
                      <Badge {...statusBadge(POLICY_STATUS_BADGE, p.status)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </div>
    </>
  );
}
