import { ReportDownload } from "../../components/ReportDownload";
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
import { TabFrame } from "./common";
interface RenewalsData {
  leads: Account[];
  clients: Account[];
  policies: Policy[];
  carriers: Carrier[];
  quotes: Quote[];
}

const EMPTY: RenewalsData = {
  leads: [],
  clients: [],
  policies: [],
  carriers: [],
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
      const [leads, clients, policies, carriers, quotes] = await Promise.all([
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
        listAllPages((nextToken) => client.models.Quote.list({ nextToken })),
      ]);
      return {
        leads,
        clients,
        policies,
        carriers,
        quotes,
      };
    },
    [],
    { initialData: EMPTY, errorMessage: "Failed to load renewals" }
  );
  const { leads, clients, policies, carriers, quotes } = res.data;

  const carrierName = useMemo(
    () => new Map(carriers.map((c) => [c.id, c.name])),
    [carriers]
  );

  // The FULL renewal set, decorated with carrier and marketing status —
  // horizon filtering happens at render, so the chip counts stay statements
  // about all of it rather than about whichever horizon is selected.
  const rows = useMemo<WorkRow[]>(() => {
    const quotesByAccount = new Map<string, Quote[]>();
    for (const q of quotes) {
      const list = quotesByAccount.get(q.accountId);
      if (list) list.push(q);
      else quotesByAccount.set(q.accountId, [q]);
    }
    return buildRenewalRows(leads, clients, policies, daysUntil).map((base) => ({
      ...base,
      carrierName: base.carrierId ? carrierName.get(base.carrierId) ?? null : null,
      marketing: renewalMarketing(
        quotedWithinWindow(
          quotesByAccount.get(base.accountId) ?? [],
          base.date,
          daysUntil,
          { accountId: base.accountId, policyId: policies.find(p => p.accountId === base.accountId && p.expirationDate === base.date)?.id,
            lines: [...new Set(policies.filter(p => p.accountId === base.accountId && p.expirationDate === base.date).flatMap(p => (p.lines ?? []).filter((l): l is string => !!l)))] }
        )
      ),
    }));
  }, [leads, clients, policies, quotes, carrierName]);

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
      (r) => r.marketing.kind === "none"
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
    },
    "days"
  );

  return (
    <TabFrame res={res}>
      <div className="card">
        <div className="toolbar" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>Upcoming renewals</h2>
          <div className="grow" />
          <ReportDownload report={{ title: "Upcoming renewals", filters: `${horizon === "overdue" ? "Overdue only" : `Next ${horizon} days, including overdue`} · sorted by ${sortKey} (${dir}) · ${hero.accounts} accounts · ${hero.unmarketed} without usable quotes`, sections: [{ title: "Renewals", columns: ["Account", "Stage", "Carrier", "Lines", "Expires", "Days", "Premium (USD)", "Renewal quote"], rows: sorted.map(r => [r.name, r.kind, r.carrierName ?? (r.kind === "LEAD" ? "Incumbent" : "—"), r.lines?.join(", "), r.date, r.days, r.premium, r.marketing.kind === "quoted" ? "Usable quote recorded" : "No usable quote recorded"]) }] }} />
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
                  : `premium expiring in the next ${horizon} days · ${hero.accounts} ${hero.accounts === 1 ? "account" : "accounts"} · ${hero.unmarketed} without usable quotes`}
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
                    <SortTh label="Renewal quote" colKey="marketing" sortKey={sortKey} dir={dir} onToggle={toggle} />
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

function MarketingBadge({ m }: { m: RenewalMarketing }) {
  return m.kind === "quoted" ? <Badge cls="green" label="Usable quote recorded" /> : <Badge cls="gray" label="No usable quote" />;
}
