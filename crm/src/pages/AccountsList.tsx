import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  client,
  fmtDate,
  fmtMoney,
  fmtNum,
  listAllPages,
  type Account,
  type Contact,
  type Policy,
} from "../lib/client";
import { primaryContact } from "../lib/contacts";
import { useAsyncResource } from "../lib/useAsyncResource";
import { useSort, SortTh } from "../lib/useSort";

export default function AccountsList({ stage }: { stage: "LEAD" | "CLIENT" }) {
  const [search, setSearch] = useState("");
  const navigate = useNavigate();

  const {
    data: accounts,
    loading,
    error,
  } = useAsyncResource(
    () =>
      listAllPages((nextToken) =>
        client.models.Account.list({ filter: { stage: { eq: stage } }, nextToken })
      ),
    [stage],
    { initialData: [] as Account[], errorMessage: "Failed to load accounts" }
  );

  // Renewal dates only. A failure here costs the "Renewal" column its dates
  // and nothing else, so it stays out of the page-level error — the accounts
  // table is still worth showing without it.
  const { data: policies } = useAsyncResource(
    async () => (await client.models.Policy.list()).data,
    [],
    { initialData: [] as Policy[] }
  );

  // The contact column, which used to be two Account columns. Same shape as
  // the policies read above and for the same reason: it is a lookup table, its
  // failure costs one column and nothing else, so it stays out of the
  // page-level error rather than blanking a table that is still worth showing.
  const { data: contacts } = useAsyncResource(
    () => listAllPages((nextToken) => client.models.Contact.list({ nextToken })),
    [],
    { initialData: [] as Contact[] }
  );

  const contactsByAccount = useMemo(() => {
    const map = new Map<string, Contact[]>();
    for (const c of contacts) {
      const list = map.get(c.accountId);
      if (list) list.push(c);
      else map.set(c.accountId, [c]);
    }
    return map;
  }, [contacts]);

  /** The one name shown per row — the same rule the ACORD insured block uses. */
  const contactOf = (a: Account) =>
    primaryContact(contactsByAccount.get(a.id) ?? []);

  // Renewal date: clients → earliest ACTIVE policy expiration;
  // leads → incumbent policy expiration.
  const renewalByAccount = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of policies) {
      if (p.status !== "ACTIVE" || !p.expirationDate) continue;
      const cur = map.get(p.accountId);
      if (!cur || p.expirationDate < cur) map.set(p.accountId, p.expirationDate);
    }
    return map;
  }, [policies]);

  const renewalOf = (a: Account): string | null =>
    stage === "CLIENT"
      ? renewalByAccount.get(a.id) ?? null
      : a.currentPolicyExpiration ?? null;

  const q = search.trim().toLowerCase();
  const filtered = q
    ? accounts.filter((a) =>
        [
          a.name,
          a.city,
          a.state,
          // Every contact, not just the primary one: searching for the board
          // president used to find nothing unless they happened to be the one
          // person the Account columns could hold.
          ...(contactsByAccount.get(a.id) ?? []).flatMap((c) => [c.name, c.email]),
        ]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q))
      )
    : accounts;

  // Default: policy end date ascending — next up / expired at the top,
  // accounts without a date after, alphabetically.
  const { sorted, sortKey, dir, toggle } = useSort(
    filtered,
    {
      name: (a) => a.name,
      type: (a) => a.type,
      contact: (a) => contactOf(a)?.name ?? null,
      location: (a) => [a.city, a.state].filter(Boolean).join(", ") || null,
      units: (a) => a.unitCount,
      tiv: (a) => a.totalInsuredValue,
      // When the lead entered the pipeline — the row's own creation stamp,
      // which every intake path (form, web lead) shares.
      entered: (a) => a.createdAt,
      renewal: (a) => renewalOf(a),
    },
    "renewal"
  );

  const label = stage === "LEAD" ? "Leads" : "Clients";

  return (
    <>
      <h1>{label}</h1>
      <p className="sub">
        {stage === "LEAD"
          ? "Prospects — converted to clients when a quote is bound"
          : "Bound accounts (created automatically from leads)"}
      </p>

      <div className="toolbar">
        <div className="field grow" style={{ maxWidth: 360 }}>
          <input
            placeholder={`Search ${label.toLowerCase()}…`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {stage === "LEAD" && (
          <Link to="/leads/new">
            <button className="primary">+ New lead</button>
          </Link>
        )}
      </div>

      <div className="card">
        {loading ? (
          <p className="muted small">Loading…</p>
        ) : error ? (
          <p className="error-text">{error}</p>
        ) : sorted.length === 0 ? (
          <p className="muted small">No {label.toLowerCase()} found.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <SortTh label="Name" colKey="name" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Type" colKey="type" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Contact" colKey="contact" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Location" colKey="location" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Units" colKey="units" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="TIV" colKey="tiv" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  {stage === "LEAD" && (
                    <SortTh label="Entered" colKey="entered" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  )}
                  <SortTh
                    label={stage === "LEAD" ? "Incumbent expires" : "Renewal"}
                    colKey="renewal"
                    sortKey={sortKey}
                    dir={dir}
                    onToggle={toggle}
                  />
                </tr>
              </thead>
              <tbody>
                {sorted.map((a) => {
                  const renewal = renewalOf(a);
                  const contact = contactOf(a);
                  return (
                    <tr
                      key={a.id}
                      className="clickable"
                      onClick={() => navigate(`/accounts/${a.id}`)}
                    >
                      <td>
                        <strong>{a.name}</strong>
                      </td>
                      <td>
                        <span className="badge gray">{a.type}</span>
                      </td>
                      <td>
                        {contact?.name ?? "—"}
                        {contact?.email && (
                          <div className="muted small">{contact.email}</div>
                        )}
                      </td>
                      <td>{[a.city, a.state].filter(Boolean).join(", ") || "—"}</td>
                      <td>{fmtNum(a.unitCount)}</td>
                      <td>{fmtMoney(a.totalInsuredValue)}</td>
                      {stage === "LEAD" && (
                        <td>{a.createdAt ? fmtDate(a.createdAt.slice(0, 10)) : "—"}</td>
                      )}
                      <td>{renewal ? fmtDate(renewal) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
