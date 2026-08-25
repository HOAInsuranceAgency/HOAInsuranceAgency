import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  client,
  daysUntil,
  fmtDate,
  listAllPages,
  type Account,
  type Policy,
} from "../../lib/client";
import {
  Badge,
  statusBadge,
  urgencyBadge,
  ACCOUNT_STAGE_BADGE,
  RENEWAL_HORIZON_SCALE,
} from "../../lib/badges";
import { useSort, SortTh } from "../../lib/useSort";
import { useAsyncResource } from "../../lib/useAsyncResource";
import { renewalChipCounts } from "../../lib/dashboardStats";
import { TabFrame } from "./common";

// ── Upcoming renewals: client policies + lead incumbent expirations ────

interface RenewalsData {
  leads: Account[];
  clients: Account[];
  policies: Policy[];
}

const EMPTY: RenewalsData = { leads: [], clients: [], policies: [] };

interface RenewalRow {
  accountId: string;
  name: string;
  kind: "CLIENT" | "LEAD";
  date: string; // YYYY-MM-DD
  days: number;
  detail: string;
}

/**
 * Overdue is a horizon of its own, not a distance on the day scale: a
 * renewal date that has passed unhandled is a different pile of work from
 * one approaching, and the card this tab grew out of showed such rows in
 * every horizon while counting them in none.
 */
type Horizon = "overdue" | 30 | 60 | 90;

export default function RenewalsTab() {
  const [horizon, setHorizon] = useState<Horizon>(90);
  const navigate = useNavigate();

  const res = useAsyncResource<RenewalsData>(
    async () => {
      const [leads, clients, policies] = await Promise.all([
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
        listAllPages((nextToken) => client.models.Policy.list({ nextToken })),
      ]);
      return { leads, clients, policies };
    },
    [],
    { initialData: EMPTY, errorMessage: "Failed to load renewals" }
  );
  const { leads, clients, policies } = res.data;

  // The FULL renewal set — horizon filtering happens at render, so the chip
  // counts can be statements about all of it rather than about whichever
  // horizon happens to be selected.
  const rows = useMemo(() => {
    const out: RenewalRow[] = [];
    const clientById = new Map(clients.map((c) => [c.id, c]));

    // A date `daysUntil` can't read is dropped rather than carried as a row
    // with no number in it.
    for (const p of policies) {
      if (p.status !== "ACTIVE" || !p.expirationDate) continue;
      const acct = clientById.get(p.accountId);
      if (!acct) continue;
      const days = daysUntil(p.expirationDate);
      if (days == null) continue;
      out.push({
        accountId: acct.id,
        name: acct.name,
        kind: "CLIENT",
        date: p.expirationDate,
        days,
        detail: `Policy ${p.policyNumber || "—"} · ${(p.lines ?? []).filter(Boolean).join(", ") || "—"}`,
      });
    }
    for (const l of leads) {
      if (!l.currentPolicyExpiration) continue;
      const days = daysUntil(l.currentPolicyExpiration);
      if (days == null) continue;
      out.push({
        accountId: l.id,
        name: l.name,
        kind: "LEAD",
        date: l.currentPolicyExpiration,
        days,
        detail: "Incumbent policy expires",
      });
    }
    return out;
  }, [leads, clients, policies]);

  const counts = useMemo(() => renewalChipCounts(rows), [rows]);

  // A day horizon includes its overdue rows — work past its date does not
  // stop being within 30 days of now — while the Overdue chip isolates them.
  const visible = useMemo(
    () =>
      horizon === "overdue"
        ? rows.filter((r) => r.days < 0)
        : rows.filter((r) => r.days <= horizon),
    [rows, horizon]
  );

  // Soonest renewal first — the work that's most at risk floats up.
  const { sorted, sortKey, dir, toggle } = useSort(
    visible,
    {
      account: (r) => r.name,
      renewal: (r) => r.date,
      days: (r) => r.days,
      detail: (r) => r.detail,
    },
    "days"
  );

  return (
    <TabFrame res={res}>
      <div className="card">
        <div className="toolbar" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>Upcoming renewals</h2>
          <div className="grow" />
          <div className="chip-row">
            <button
              className={horizon === "overdue" ? "on" : ""}
              onClick={() => setHorizon("overdue")}
            >
              Overdue · {counts.overdue}
            </button>
            {([30, 60, 90] as const).map((d) => (
              <button
                key={d}
                className={horizon === d ? "on" : ""}
                onClick={() => setHorizon(d)}
              >
                {d}d · {d === 30 ? counts.d30 : d === 60 ? counts.d60 : counts.d90}
              </button>
            ))}
          </div>
        </div>

        {sorted.length === 0 ? (
          <p className="muted small">
            {horizon === "overdue"
              ? "Nothing overdue — no renewal date has passed unhandled."
              : `Nothing renewing in the next ${horizon} days. Lead renewal dates come from "Current policy expiration" (set manually or via AI extraction).`}
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <SortTh label="Account" colKey="account" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <th></th>
                  <SortTh label="Renewal" colKey="renewal" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Days" colKey="days" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Detail" colKey="detail" sortKey={sortKey} dir={dir} onToggle={toggle} />
                </tr>
              </thead>
              <tbody>
                {sorted.map((r, i) => (
                  <tr
                    key={`${r.accountId}-${i}`}
                    className="clickable"
                    onClick={() => navigate(`/accounts/${r.accountId}`)}
                  >
                    <td>
                      <strong>{r.name}</strong>
                    </td>
                    <td>
                      <Badge {...statusBadge(ACCOUNT_STAGE_BADGE, r.kind)} />
                    </td>
                    <td>{fmtDate(r.date)}</td>
                    <td className="days-badge">
                      <Badge {...urgencyBadge(r.days, RENEWAL_HORIZON_SCALE)} />
                    </td>
                    <td className="small muted">{r.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </TabFrame>
  );
}
