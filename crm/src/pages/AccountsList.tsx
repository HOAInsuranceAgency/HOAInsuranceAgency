import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { client, fmtMoney, type Account } from "../lib/client";

export default function AccountsList({ stage }: { stage: "LEAD" | "CLIENT" }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    setLoading(true);
    client.models.Account.list({ filter: { stage: { eq: stage } } }).then(
      ({ data }) => {
        setAccounts(data.sort((a, b) => a.name.localeCompare(b.name)));
        setLoading(false);
      }
    );
  }, [stage]);

  const q = search.trim().toLowerCase();
  const filtered = q
    ? accounts.filter((a) =>
        [a.name, a.city, a.state, a.contactFirstName, a.contactLastName, a.contactEmail]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q))
      )
    : accounts;

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
        ) : filtered.length === 0 ? (
          <p className="muted small">No {label.toLowerCase()} found.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Contact</th>
                  <th>Location</th>
                  <th>Units</th>
                  <th>TIV</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((a) => (
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
                      {[a.contactFirstName, a.contactLastName].filter(Boolean).join(" ") || "—"}
                      {a.contactEmail && (
                        <div className="muted small">{a.contactEmail}</div>
                      )}
                    </td>
                    <td>{[a.city, a.state].filter(Boolean).join(", ") || "—"}</td>
                    <td>{a.unitCount ?? "—"}</td>
                    <td>{fmtMoney(a.totalInsuredValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
