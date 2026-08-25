import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  client,
  daysUntil,
  fmtDate,
  fmtMoney,
  listAllPages,
  type Account,
  type Carrier,
  type Policy,
  type Quote,
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
import {
  buildRenewalRows,
  quotedWithinWindow,
  renewalChipCounts,
  renewalMarketing,
  renewalMarketingRank,
  type RenewalMarketing,
  type RenewalRowBase,
} from "../../lib/dashboardStats";
import { localToday, TabFrame } from "./common";
import type { Schema } from "../../../amplify/data/resource";

type TaskRow = Schema["MarketingTask"]["type"];

// ── The renewal workspace: what expires, what it's worth, is it being
// worked. Expiring policies (and lead incumbent expirations) joined with
// the nightly sweep's MarketingTask rows — two datasets that both existed
// and never met on screen. ──────────────────────────────────────────────

interface RenewalsData {
  leads: Account[];
  clients: Account[];
  policies: Policy[];
  carriers: Carrier[];
  tasks: TaskRow[];
  /** All statuses — the marketing column treats a quote in the window as
   * "started" even when the sweep left no task trail for it. */
  quotes: Quote[];
}

const EMPTY: RenewalsData = {
  leads: [],
  clients: [],
  policies: [],
  carriers: [],
  tasks: [],
  quotes: [],
};

interface WorkRow extends RenewalRowBase {
  carrierName: string | null;
  marketing: RenewalMarketing;
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
      const [leads, clients, policies, carriers, tasks, quotes] = await Promise.all([
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
        listAllPages((nextToken) => client.models.Carrier.list({ nextToken })),
        listAllPages((nextToken) =>
          client.models.MarketingTask.list({ limit: 500, nextToken })
        ),
        listAllPages((nextToken) => client.models.Quote.list({ nextToken })),
      ]);
      return {
        leads,
        clients,
        policies,
        carriers,
        tasks: tasks as TaskRow[],
        quotes,
      };
    },
    [],
    { initialData: EMPTY, errorMessage: "Failed to load renewals" }
  );
  const { leads, clients, policies, carriers, tasks, quotes } = res.data;

  const carrierName = useMemo(
    () => new Map(carriers.map((c) => [c.id, c.name])),
    [carriers]
  );

  // The FULL renewal set, decorated with carrier and marketing status —
  // horizon filtering happens at render, so the chip counts stay statements
  // about all of it rather than about whichever horizon is selected.
  const rows = useMemo<WorkRow[]>(() => {
    const tasksByRenewal = new Map<string, TaskRow[]>();
    for (const t of tasks) {
      const key = `${t.accountId}:${t.expirationDate ?? ""}`;
      const list = tasksByRenewal.get(key);
      if (list) list.push(t);
      else tasksByRenewal.set(key, [t]);
    }
    const quotesByAccount = new Map<string, Quote[]>();
    for (const q of quotes) {
      const list = quotesByAccount.get(q.accountId);
      if (list) list.push(q);
      else quotesByAccount.set(q.accountId, [q]);
    }
    const today = localToday();
    return buildRenewalRows(leads, clients, policies, daysUntil).map((base) => ({
      ...base,
      carrierName: base.carrierId ? carrierName.get(base.carrierId) ?? null : null,
      marketing: renewalMarketing(
        tasksByRenewal.get(`${base.accountId}:${base.date}`) ?? [],
        today,
        // The sweep skips task creation for already-quoted carriers, so a
        // quote in the marketing window counts as started with no task row.
        quotedWithinWindow(
          quotesByAccount.get(base.accountId) ?? [],
          base.date,
          daysUntil
        )
      ),
    }));
  }, [leads, clients, policies, tasks, quotes, carrierName]);

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

  const hero = useMemo(() => {
    const premium = visible.reduce((s, r) => s + (r.premium ?? 0), 0);
    const accounts = new Set(visible.map((r) => r.accountId)).size;
    const unmarketed = visible.filter(
      (r) => r.marketing.kind === "none" || r.marketing.kind === "missed"
    ).length;
    return { premium, accounts, unmarketed };
  }, [visible]);

  // Soonest renewal first — the work that's most at risk floats up.
  const { sorted, sortKey, dir, toggle } = useSort(
    visible,
    {
      account: (r) => r.name,
      carrier: (r) => r.carrierName ?? (r.kind === "LEAD" ? "incumbent" : null),
      renewal: (r) => r.date,
      days: (r) => r.days,
      premium: (r) => r.premium,
      marketing: (r) => renewalMarketingRank(r.marketing),
      submitBy: (r) =>
        r.marketing.kind === "missed" || r.marketing.kind === "open"
          ? r.marketing.submitBy
          : null,
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
          <>
            <div className="hero-line">
              <span className="n">{fmtMoney(hero.premium)}</span>
              <span className="l">
                {horizon === "overdue"
                  ? `premium past its renewal date · ${hero.accounts} ${hero.accounts === 1 ? "account" : "accounts"}`
                  : `premium expiring in the next ${horizon} days · ${hero.accounts} ${hero.accounts === 1 ? "account" : "accounts"} · ${hero.unmarketed} not yet marketed`}
              </span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <SortTh label="Account" colKey="account" sortKey={sortKey} dir={dir} onToggle={toggle} />
                    <th></th>
                    <SortTh label="Carrier" colKey="carrier" sortKey={sortKey} dir={dir} onToggle={toggle} />
                    <th>Lines</th>
                    <SortTh label="Expires" colKey="renewal" sortKey={sortKey} dir={dir} onToggle={toggle} />
                    <SortTh label="Days" colKey="days" sortKey={sortKey} dir={dir} onToggle={toggle} />
                    <SortTh label="Premium" colKey="premium" sortKey={sortKey} dir={dir} onToggle={toggle} />
                    <SortTh label="Marketing" colKey="marketing" sortKey={sortKey} dir={dir} onToggle={toggle} />
                    <SortTh label="Submit by" colKey="submitBy" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r, i) => (
                    <tr
                      key={`${r.accountId}-${r.date}-${i}`}
                      className="clickable"
                      onClick={() => navigate(`/accounts/${r.accountId}`)}
                    >
                      <td>
                        <strong>{r.name}</strong>
                      </td>
                      <td>
                        <Badge {...statusBadge(ACCOUNT_STAGE_BADGE, r.kind)} />
                      </td>
                      <td>
                        {r.carrierName ?? (
                          <span className="muted">
                            {r.kind === "LEAD" ? "incumbent" : "—"}
                          </span>
                        )}
                      </td>
                      <td className="small muted">
                        {r.lines && r.lines.length > 0 ? r.lines.join(", ") : "—"}
                      </td>
                      <td>{fmtDate(r.date)}</td>
                      <td className="days-badge">
                        <Badge {...urgencyBadge(r.days, RENEWAL_HORIZON_SCALE)} />
                      </td>
                      <td>{r.premium == null ? "—" : fmtMoney(r.premium)}</td>
                      <td>
                        <MarketingBadge m={r.marketing} />
                      </td>
                      <td>
                        {r.marketing.kind === "missed"
                          ? fmtDate(r.marketing.submitBy)
                          : r.marketing.kind === "open" && r.marketing.submitBy
                            ? fmtDate(r.marketing.submitBy)
                            : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </TabFrame>
  );
}

/** The Marketing column's pill. "Passed" (tasks all settled without a
 * quote — deliberate) is not "Not started" (nothing ever raised), even
 * though both are grey. */
function MarketingBadge({ m }: { m: RenewalMarketing }) {
  switch (m.kind) {
    case "quoted":
      return <Badge cls="green" label="Quoted ✓" />;
    case "missed":
      return <Badge cls="red" label="Window missed" />;
    case "open":
      return (
        <Badge cls="blue" label={`${m.count} ${m.count === 1 ? "task" : "tasks"} open`} />
      );
    case "passed":
      return <Badge cls="gray" label="Passed" />;
    case "none":
      return <Badge cls="gray" label="Not started" />;
  }
}
