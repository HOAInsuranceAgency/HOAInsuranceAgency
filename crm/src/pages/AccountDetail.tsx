import { useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import {
  client,
  fmtDate,
  type Account,
  type UserProfile,
} from "../lib/client";
import { Badge, statusBadge, ACCOUNT_STAGE_BADGE } from "../lib/badges";
import DocumentsPanel from "../components/DocumentsPanel";
import QuotesPanel from "../components/QuotesPanel";
import AccountMarketingTasks from "../components/MarketingTasks";
import PropertyPanel from "../components/PropertyPanel";
import ContactsCard from "../components/ContactsCard";
import FormsTab from "../components/FormsTab";
import ExtractionPanel from "../components/ExtractionPanel";
import Celebration from "../components/Celebration";
import { useAsyncResource } from "../lib/useAsyncResource";
import { OverviewTab } from "./account/OverviewTab";
import { DeleteLeadZone } from "./account/DeleteLeadZone";
import { PoliciesTab } from "./account/PoliciesTab";
import { PriorCarrierTab } from "./account/PriorCarrierTab";
import { LossesTab } from "./account/LossesTab";
import { ActivityTab } from "./account/ActivityTab";
import { CertificatesTab } from "./account/CertificatesTab";

type Tab =
  | "overview"
  | "priorcarrier"
  | "losses"
  | "quotes"
  | "policies"
  | "documents"
  | "certificates"
  | "activity";

const VALID_TABS: Tab[] = [
  "overview",
  "priorcarrier",
  "losses",
  "quotes",
  "policies",
  "documents",
  "certificates",
  "activity",
];

/**
 * Tabs that only make sense while the account is still a prospect.
 *
 * Prior coverage is what the association is insured under *today*; once a
 * quote binds, the Policy records answer that question and a second tab
 * claiming to invites someone to maintain two answers to it. The rows stay in
 * the table either way — every renewal submission fills the ACORD 125's
 * prior-coverage block from them.
 */
const LEAD_ONLY_TABS: ReadonlySet<Tab> = new Set<Tab>(["priorcarrier"]);

/** The tabs an account of this stage offers, in display order. */
export function tabsFor(stage: string | null | undefined): [Tab, string][] {
  const isLead = stage !== "CLIENT";
  return [
    ["overview", "Overview"],
    ...(isLead ? ([["priorcarrier", "Prior coverage"]] as [Tab, string][]) : []),
    // Not lead-only: loss history follows the account, and a renewal
    // submission declares the same losses a new-business one did.
    ["losses", "Losses"],
    ["quotes", "Quotes"],
    ["policies", "Policies"],
    ["documents", "Documents"],
    ["certificates", "Certificates"],
    ["activity", "Activity"],
  ];
}

/**
 * The tab actually rendered, given the one the URL or a click asked for.
 *
 * `?tab=` is read before the account has loaded, so at that moment there is
 * nothing to check the stage against. A client reached by a bookmarked
 * `?tab=priorcarrier` would otherwise sit on a tab with no button to leave it
 * by — the tab list would not contain it, so nothing would be highlighted and
 * the panel would be one nobody can navigate back to.
 *
 * Derived rather than corrected in an effect: correcting state after the fact
 * renders the wrong tab for a frame first, and leaves two places that know
 * the rule.
 */
export function resolveTab(requested: Tab, stage: string | null | undefined): Tab {
  return stage === "CLIENT" && LEAD_ONLY_TABS.has(requested) ? "overview" : requested;
}

export default function AccountDetail({ profile }: { profile: UserProfile }) {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const initialTab = searchParams.get("tab") as Tab | null;
  const [tab, setTab] = useState<Tab>(
    initialTab && VALID_TABS.includes(initialTab) ? initialTab : "overview"
  );
  const [celebrate, setCelebrate] = useState(false);
  const prevStage = useRef<string | null>(null);

  const res = useAsyncResource(
    async () => {
      if (!id) return null;
      return (await client.models.Account.get({ id })).data;
    },
    [id],
    { initialData: null as Account | null, errorMessage: "Failed to load account" }
  );
  const account = res.data;
  const setAccount = res.setData;

  // Fire the celebration on a LEAD → CLIENT transition (quote bound). Runs off
  // the locally-patched account QuotesPanel hands back, not a re-read.
  useEffect(() => {
    const stage = account?.stage ?? null;
    if (prevStage.current === "LEAD" && stage === "CLIENT") setCelebrate(true);
    prevStage.current = stage;
  }, [account?.stage]);

  /**
   * Derived, not stored. As a `useState` flag this was set on a missing record
   * and never cleared, so navigating from a bad id to a good one kept
   * rendering "Account not found." over the account that had just loaded.
   */
  const notFound = res.loaded && !res.error && account === null;

  if (!res.loaded) return <p className="muted">Loading…</p>;
  if (res.error) return <p className="error-text">{res.error}</p>;
  if (notFound) return <p>Account not found.</p>;
  if (!account) return <p className="muted">Loading…</p>;

  const tabs = tabsFor(account.stage);
  const activeTab = resolveTab(tab, account.stage);

  return (
    <>
      {celebrate && (
        <Celebration name={account.name} onDone={() => setCelebrate(false)} />
      )}
      <h1>
        {account.name}{" "}
        {/* Reads "Client"/"Lead" now, not "CLIENT"/"LEAD" — the shared table
            has one spelling and the dashboard's sentence case is it. */}
        <Badge {...statusBadge(ACCOUNT_STAGE_BADGE, account.stage)} />
      </h1>
      <p className="sub">
        {account.type} · {[account.city, account.state].filter(Boolean).join(", ") || "no location"}
        {account.convertedAt && ` · client since ${fmtDate(account.convertedAt.slice(0, 10))}`}
      </p>

      <div className="tabs">
        {tabs.map(([t, label]) => (
          <button
            key={t}
            className={activeTab === t ? "active" : ""}
            onClick={() => setTab(t)}
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === "overview" && (
        <>
          <OverviewTab account={account} onChange={setAccount} />
          <ContactsCard accountId={account.id} />
          <PropertyPanel account={account} onChange={setAccount} />
          {account.stage === "LEAD" && <DeleteLeadZone account={account} />}
        </>
      )}
      {activeTab === "quotes" && (
        <>
          <div className="card">
            <QuotesPanel account={account} onAccountChange={setAccount} />
          </div>
          <AccountMarketingTasks
            accountId={account.id}
            completedByName={`${profile.firstName} ${profile.lastName}`}
          />
        </>
      )}
      {activeTab === "priorcarrier" && <PriorCarrierTab accountId={account.id} />}
      {activeTab === "losses" && <LossesTab accountId={account.id} />}
      {activeTab === "policies" && <PoliciesTab accountId={account.id} />}
      {activeTab === "documents" && (
        <>
          <div className="card">
            <DocumentsPanel entityType="ACCOUNT" entityId={account.id} />
          </div>
          <ExtractionPanel account={account} onChange={setAccount} />
          <FormsTab account={account} profile={profile} />
        </>
      )}
      {activeTab === "certificates" && (
        <CertificatesTab account={account} profile={profile} />
      )}
      {activeTab === "activity" && <ActivityTab accountId={account.id} />}
    </>
  );
}
