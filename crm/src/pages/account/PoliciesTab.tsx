import { useRef, useState } from "react";
import {
  client,
  fmtDate,
  fmtMoney,
  friendlyError,
  listAllPages,
  type Carrier,
  type Policy,
} from "../../lib/client";
import { useAsyncResource } from "../../lib/useAsyncResource";
import { BILL_TYPE_SHORT, POLICY_STATUSES } from "../../lib/enums";
import { useSort, SortTh } from "../../lib/useSort";
import { commissionCell, termsSummary } from "../../components/QuotesPanel";
import CoverageForm from "../../components/CoverageForm";
import { SaveStatus, type SaveStatusValue } from "../../components/SaveStatus";
import { isAuthorizationError } from "../../lib/authorizationError";

export function PoliciesTab({ accountId }: { accountId: string }) {
  return <AccountPolicies key={accountId} accountId={accountId} />;
}

function AccountPolicies({ accountId }: { accountId: string }) {
  const [editing, setEditing] = useState<Policy | null>(null);
  const updates = useRef(new Set<string>());
  const [rowStatus, setRowStatus] = useState<Record<string, SaveStatusValue>>({});
  const saving = Object.values(rowStatus).some(status => status.state === "saving");

  const policyRes = useAsyncResource(
    () =>
      listAllPages((nextToken) =>
        client.models.Policy.list({
          filter: { accountId: { eq: accountId } },
          nextToken,
        })
      ),
    [accountId],
    { initialData: [] as Policy[], errorMessage: "Failed to load policies", clearDataOnError: isAuthorizationError }
  );
  const policies = policyRes.data;
  const setPolicies = policyRes.setData;
  // Identity-stable, so CoverageForm's `onSaved` no longer closes over a
  // fresh function every render.
  const refresh = policyRes.refetch;

  // A separate resource keeps policy refreshes from re-reading the carriers.
  const carrierRes = useAsyncResource(
    () => listAllPages(nextToken => client.models.Carrier.list({ nextToken })),
    [],
    { initialData: [] as Carrier[], errorMessage: "Failed to load carriers", clearDataOnError: isAuthorizationError }
  );
  const carrierRows = carrierRes.data;

  async function updatePolicy(id: string, patch: Partial<Policy>) {
    // Each row owns its request and feedback. Rapid clicks on one policy
    // cannot duplicate its write or suppress a distinct policy's change.
    if (updates.current.has(id)) return;
    updates.current.add(id);
    setRowStatus(previous => ({ ...previous, [id]: { state: "saving" } }));
    try {
      const { data, errors } = await client.models.Policy.update({ id, ...patch });
      if (errors?.length || !data) throw new Error(errors?.[0]?.message);
      setPolicies(ps => ps.map(p => p.id === id ? data : p));
      setRowStatus(previous => ({ ...previous, [id]: { state: "saved", message: "Policy updated." } }));
    } catch (error) {
      setRowStatus(previous => ({ ...previous, [id]: {
        state: "error", message: friendlyError(error, "Couldn't update that policy."),
      } }));
    } finally { updates.current.delete(id); }
  }

  // Carrier picker order only — no header to click, so the default stands.
  const { sorted: carriers } = useSort(carrierRows, { name: (c) => c.name }, "name");

  const carrierName = (id: string | null | undefined) =>
    carriers.find((c) => c.id === id)?.name ?? "—";

  // Most recently effective policy first, as the fetch used to order them.
  const { sorted, sortKey, dir, toggle } = useSort(
    policies,
    {
      number: (p) => p.policyNumber,
      carrier: (p) => (p.carrierId ? carrierName(p.carrierId) : null),
      lines: (p) => (p.lines ?? []).filter(Boolean).join(", "),
      billType: (p) => p.billType,
      premium: (p) => p.premium,
      commission: (p) => p.commissionPct,
      effective: (p) => p.effectiveDate,
      expires: (p) => p.expirationDate,
      bound: (p) => p.datePolicyBound,
      status: (p) => p.status,
    },
    "effective",
    "desc"
  );

  return (
    <div className="card">
      <h2>Policies</h2>

      {editing && policies.some(p => p.id === editing.id) && (
        <CoverageForm
          key={editing.id}
          kind="policy"
          accountId={accountId}
          carriers={carriers}
          existing={editing}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
          onCancel={() => setEditing(null)}
        />
      )}

      {/* Surfaced rather than ignored: without carriers every row's carrier
          column reads "—", indistinguishable from a policy with none set. */}
      {carrierRes.error && <p className="error-text" role="alert">
        {carrierRes.error}{" "}
        <button className="secondary" disabled={carrierRes.loading} onClick={() => void carrierRes.refetch()}>Retry carriers</button>
      </p>}
      {policyRes.error && <p className="error-text" role="alert">
        {policyRes.error}{" "}
        <button className="secondary" disabled={policyRes.loading} onClick={() => void refresh()}>Retry policies</button>
      </p>}

      {!policyRes.loaded || (policyRes.loading && policies.length === 0) ? (
        <p className="muted small">Loading…</p>
      ) : policies.length === 0 ? (
        !policyRes.error && <p className="muted small">
          No policies. Policies are created by binding a quote.
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <SortTh label="Policy #" colKey="number" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <SortTh label="Carrier" colKey="carrier" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <SortTh label="Lines" colKey="lines" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <SortTh label="Bill" colKey="billType" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <SortTh label="Premium" colKey="premium" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <SortTh label="Commission" colKey="commission" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <th>Terms</th>
                <SortTh label="Effective" colKey="effective" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <SortTh label="Expires" colKey="expires" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <SortTh label="Bound" colKey="bound" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <SortTh label="Status" colKey="status" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((p) => (
                <tr key={p.id}>
                  {/* Not a link any more. The policy page existed to host
                      billing, and billing is now the account's Invoices tab —
                      what remained was a read-only restatement of this row.
                      Editing is the button at the end of it. */}
                  <td>{p.policyNumber || "—"}</td>
                  <td className="small">{carrierName(p.carrierId)}</td>
                  <td className="small">{(p.lines ?? []).filter(Boolean).join(", ") || "—"}</td>
                  {/* Blank for anything bound before the field existed, which
                      is honest — "Direct" would be a guess about money. */}
                  <td className="small">{BILL_TYPE_SHORT[p.billType ?? ""] ?? "—"}</td>
                  <td>{fmtMoney(p.premium)}</td>
                  <td className="small">{commissionCell(p)}</td>
                  <td className="small">{termsSummary(p)}</td>
                  <td>{fmtDate(p.effectiveDate)}</td>
                  <td>{fmtDate(p.expirationDate)}</td>
                  {/* Stamped by the bind flow; blank for policies bound
                      before the field existed. */}
                  <td>{fmtDate(p.datePolicyBound?.slice(0, 10))}</td>
                  <td>
                    <select
                      aria-label={`Status for policy ${p.policyNumber || p.id}`}
                      disabled={rowStatus[p.id]?.state === "saving" || policyRes.loading || Boolean(policyRes.error) || Boolean(editing)}
                      value={p.status}
                      onChange={(e) =>
                        updatePolicy(p.id, { status: e.target.value as Policy["status"] })
                      }
                    >
                      {POLICY_STATUSES.map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                    <SaveStatus {...(rowStatus[p.id] ?? { state: "idle" })} />
                  </td>
                  <td>
                    <button className="link" disabled={saving || policyRes.loading || Boolean(policyRes.error) || Boolean(editing) || !carrierRes.loaded || carrierRes.loading || Boolean(carrierRes.error)} onClick={() => setEditing(p)}>
                      Edit
                    </button>
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
