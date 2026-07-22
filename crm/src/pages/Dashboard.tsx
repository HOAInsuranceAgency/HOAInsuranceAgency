import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { client, fmtDate, type Account, type Quote } from "../lib/client";

export default function Dashboard() {
  const [leads, setLeads] = useState<Account[]>([]);
  const [clients, setClients] = useState<Account[]>([]);
  const [openQuotes, setOpenQuotes] = useState<Quote[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    client.models.Account.list({ filter: { stage: { eq: "LEAD" } } }).then(
      ({ data }) => setLeads(data)
    );
    client.models.Account.list({ filter: { stage: { eq: "CLIENT" } } }).then(
      ({ data }) => setClients(data)
    );
    client.models.Quote.list({
      filter: {
        or: [
          { status: { eq: "DRAFT" } },
          { status: { eq: "SUBMITTED" } },
          { status: { eq: "QUOTED" } },
          { status: { eq: "PRESENTED" } },
        ],
      },
    }).then(({ data }) => setOpenQuotes(data));
  }, []);

  const recentLeads = [...leads]
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
    .slice(0, 8);

  return (
    <>
      <h1>Dashboard</h1>
      <p className="sub">Pipeline at a glance</p>

      <div className="stat-row">
        <div className="stat">
          <div className="n">{leads.length}</div>
          <div className="l">Open leads</div>
        </div>
        <div className="stat">
          <div className="n">{clients.length}</div>
          <div className="l">Clients</div>
        </div>
        <div className="stat">
          <div className="n">{openQuotes.length}</div>
          <div className="l">Quotes in flight</div>
        </div>
      </div>

      <div className="card">
        <h2>Recent leads</h2>
        {recentLeads.length === 0 ? (
          <p className="muted small">
            No leads yet. <Link to="/leads/new">Create the first one.</Link>
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>State</th>
                  <th>Source</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {recentLeads.map((a) => (
                  <tr
                    key={a.id}
                    className="clickable"
                    onClick={() => navigate(`/accounts/${a.id}`)}
                  >
                    <td>{a.name}</td>
                    <td>{a.type}</td>
                    <td>{a.state ?? "—"}</td>
                    <td>{a.source ?? "—"}</td>
                    <td>{fmtDate(a.createdAt?.slice(0, 10))}</td>
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
