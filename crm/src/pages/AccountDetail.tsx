import AccountSummary from "../components/AccountSummary";
import { Breadcrumb, Disclosure, SectionNav } from "../components/ui/kit";
import SubmissionsPanel from "../components/SubmissionsPanel";
import HoneycombEstimates from "../components/HoneycombEstimates";
import LeadWorkflowPanel from "../components/LeadWorkflowPanel";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router-dom";
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
import { InvoicesTab } from "./account/InvoicesTab";
import { FinancingTab } from "./account/FinancingTab";
import { PriorCarrierTab } from "./account/PriorCarrierTab";
import { LossesTab } from "./account/LossesTab";
import { ActivityTab } from "./account/ActivityTab";
import { CertificatesTab } from "./account/CertificatesTab";

type Tab =
  | "details"
  | "contacts"
  | "property"
  | "extraction"
  | "forms"
  | "renewal"
  | "overview"
  | "priorcarrier"
  | "losses"
  | "submissions"
  | "quotes"
  | "policies"
  | "invoices"
  | "financing"
  | "documents"
  | "certificates"
  | "activity";

const VALID_TABS: Tab[] = ["details", "contacts", "property", "extraction", "forms", "renewal",
  "overview",
  "priorcarrier",
  "losses",
  "submissions",
  "quotes",
  "policies",
  "invoices",
  "financing",
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

/**
 * Tabs that only mean something once the account is a client.
 *
 * A lead has no policy — a policy exists because a quote bound, and binding is
 * what makes the account a client. The Policies tab on a lead could therefore
 * only ever say "No policies", which reads as data missing rather than data
 * that cannot exist yet. Invoices USED to follow it, until the W8 E2E caught
 * the contradiction: billing a quote before bind is the new-business flow,
 * and new business is a lead — hiding the money tabs from leads hid the
 * feature from its audience. So Invoices and Financing show at every stage
 * now, and only Policies waits for the bind that makes it true.
 *
 * Not enforced anywhere but the tab bar. The rows are still reachable and
 * still load — this hides a panel that has nothing to show, it does not make
 * the records conditional.
 */
const CLIENT_ONLY_TABS: ReadonlySet<Tab> = new Set<Tab>(["policies"]);

/**
 * The tabs an account of this stage offers, in display order.
 *
 * Financing used to be conditional on the premium-finance module flag, and
 * both functions took it as an option so a bookmarked `?tab=financing` on a
 * disabled module fell back to Overview. The module is always on as of
 * 2026-08-25, so the tab is simply a tab; stage is the only thing that
 * still decides what an account offers.
 */
export function tabsFor(stage: string | null | undefined): [Tab, string][] {
  const isLead = stage !== "CLIENT";
  return [
    ["overview", "Overview"],
    ...(isLead ? ([["priorcarrier", "Prior coverage"]] as [Tab, string][]) : []),
    // Not lead-only: loss history follows the account, and a renewal
    // submission declares the same losses a new-business one did.
    ["losses", "Losses"],
    ["submissions", "Submissions"],
    ["quotes", "Quotes"],
    // Policies stay client-only — a lead by definition has none. Invoices
    // and Financing do NOT (since the W8 E2E caught them hidden): billing
    // a QUOTE before bind is new business, and new business is a lead —
    // the invoice and its loan roll onto the policy when the bind
    // converts them.
    ...(isLead ? [] : ([["policies", "Policies"]] as [Tab, string][])),
    ["invoices", "Invoices"],
    ["financing", "Financing"],
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
export function resolveTab(
  requested: Tab,
  stage: string | null | undefined
): Tab {
  const isClient = stage === "CLIENT";
  // Work links can outlive a lead's conversion. Resolve the shared renewal
  // entry point only after loading the account, preserving each stage's view.
  if (requested === "renewal") return isClient ? "policies" : "quotes";
  const unreachable = isClient
    ? LEAD_ONLY_TABS.has(requested)
    : CLIENT_ONLY_TABS.has(requested);
  return unreachable ? "overview" : requested;
}

export default function AccountDetail({ profile }: { profile: UserProfile }) {
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const { hash } = location;
  const returnTo = typeof location.state?.from === "string" && /^\/(leads|clients)(\?|$)/.test(location.state.from) ? location.state.from : null;

  /**
   * Derived from the URL, not stored — the Dashboard's lesson applied here.
   * State seeded once from `?tab=` desyncs the moment the URL changes
   * without a remount, and the universal search bar made that reachable:
   * it navigates to `/accounts/:id?tab=…` from ON this page, and React
   * Router reuses the mounted instance for account→account hops — so a
   * stored tab would render account A's panel under account B's URL.
   */
  const requested = searchParams.get("tab") as Tab | null;
  const tab: Tab =
    requested && VALID_TABS.includes(requested) ? requested : "overview";

  /**
   * Clicking a tab puts it in the URL — which, with `tab` derived above, is
   * the whole action. `replace` rather than `push`: switching tabs is not a
   * navigation Back should have to walk out of one step at a time.
   */
  function selectTab(t: Tab) {
    const next = new URLSearchParams(searchParams);
    next.set("tab", t);
    setSearchParams(next, { replace: true, state: location.state });
  }
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
  useEffect(() => {
    if (!res.loaded || !account || !["#contacts", "#lead-workspace", "#carrier-work"].includes(hash)) return;
    const frame = requestAnimationFrame(() => document.getElementById(hash.slice(1))?.scrollIntoView({ block: "start" }));
    return () => cancelAnimationFrame(frame);
  }, [res.loaded, account?.id, tab, hash]);

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
  const activeTab: Tab = hash === "#contacts" && tab === "overview" ? "contacts" : resolveTab(tab, account.stage);
  const section = ["details", "contacts", "property"].includes(activeTab) ? "details" : ["invoices", "financing"].includes(activeTab) ? "billing" : ["documents", "extraction"].includes(activeTab) ? "documents" : activeTab === "activity" ? "timeline" : activeTab === "overview" ? "summary" : "coverage";
  const groups = [["summary", "Summary"], ["coverage", "Coverage & markets"], ["documents", "Documents"], ["billing", "Billing"], ["timeline", "Timeline"], ["details", "Account details"]] as const;
  const defaults = { summary: "overview", coverage: "quotes", documents: "documents", billing: "invoices", timeline: "activity", details: "details" } as const;
  const subviews: [Tab, string][] = section === "coverage" ? [...tabs.filter(([key]) => ["priorcarrier", "losses", "quotes", "policies", "certificates", "submissions"].includes(key) && !(key === "certificates" && account.stage !== "CLIENT")).map(([key,label]): [Tab,string] => [key, key === "submissions" ? "Honeycomb submission" : label]), ["forms", "Application forms"]] : section === "billing" ? [["invoices", "Invoices"], ["financing", "Loans"]] : section === "documents" ? [["documents", "Files"], ["extraction", "Review extracted information"]] : section === "details" ? [["details", "Account"], ["contacts", "Contacts"], ["property", "Property & underwriting"]] : [];

  return (
    <>
      {celebrate && (
        <Celebration name={account.name} onDone={() => setCelebrate(false)} />
      )}
      <Breadcrumb to={returnTo ?? (account.stage === "CLIENT" ? "/clients" : "/leads")}>Back to {account.stage === "CLIENT" ? "clients" : "leads"}</Breadcrumb>
      <h1>
        {account.name}{" "}
        {/* Reads "Client"/"Lead" now, not "CLIENT"/"LEAD" — the shared table
            has one spelling and the dashboard's sentence case is it. */}
        <Badge {...statusBadge(ACCOUNT_STAGE_BADGE, account.stage)} />
      </h1>
      <p className="sub">
        {account.type === "ASSOCIATION" ? "Association" : account.type === "PERSONAL" ? "Personal" : "Commercial"} · {[account.city, account.state].filter(Boolean).join(", ") || "no location"}
        {/* Lifecycle dates, one each way: when the lead entered, and — once a
            bind converts them — when they became a client. */}
        {account.stage === "LEAD" &&
          account.createdAt &&
          ` · entered ${fmtDate(account.createdAt.slice(0, 10))}`}
        {account.convertedAt && ` · client since ${fmtDate(account.convertedAt.slice(0, 10))}`}
      </p>

      <SectionNav label="Account section" items={groups} value={section} onChange={value => selectTab(defaults[value])} />
      {subviews.length > 0 && <SectionNav label={`${groups.find(([key]) => key === section)?.[1]} view`} items={subviews} value={activeTab} onChange={selectTab} />}
      {activeTab === "overview" && <>
        <AccountSummary key={account.id} account={account} />
        <div id="lead-workspace"><LeadWorkflowPanel key={account.id} accountId={account.id} mode="summary" /></div>
      </>}
      {activeTab === "details" && <>
        <AccountSummary key={account.id} account={account} />
        <Disclosure title="Edit account details" description="Legal name, identifiers, attribution, values, and notes"><OverviewTab key={account.id} account={account} onChange={setAccount} /></Disclosure>
        {account.stage === "LEAD" && <Disclosure title="Delete lead"><DeleteLeadZone account={account} /></Disclosure>}
      </>}
      {activeTab === "contacts" && <div id="contacts"><ContactsCard key={account.id} accountId={account.id} /></div>}
      {activeTab === "property" && <PropertyPanel key={account.id} account={account} onChange={setAccount} />}
      {activeTab === "submissions" && <SubmissionsPanel key={account.id} account={account} initialEstimateId={searchParams.get("estimate") ?? undefined} />}
      {section === "coverage" && <p><Link to={`/carriers?account=${account.id}`}>Find markets for this account</Link></p>}
      {activeTab === "quotes" && (
        <>
          <div className="card">
            <HoneycombEstimates accountId={account.id} />
            <QuotesPanel account={account} onAccountChange={setAccount} />
          </div>
          <div id="carrier-work"><Disclosure key={hash === "#carrier-work" ? "targeted" : "closed"} title="Carrier deadlines" description="Review submission deadlines for this account." initiallyOpen={hash === "#carrier-work"}><AccountMarketingTasks
            accountId={account.id}
            completedByName={`${profile.firstName} ${profile.lastName}`}
          /></Disclosure></div>
        </>
      )}
      {activeTab === "priorcarrier" && <PriorCarrierTab accountId={account.id} />}
      {activeTab === "losses" && <LossesTab accountId={account.id} />}
      {activeTab === "policies" && <PoliciesTab accountId={account.id} />}
      {activeTab === "invoices" && <InvoicesTab accountId={account.id} />}
      {activeTab === "financing" && <FinancingTab account={account} />}
      {activeTab === "documents" && (
        <>
          <div className="card">
            <DocumentsPanel
              entityType="ACCOUNT"
              entityId={account.id}
              linkAccountId={account.id}
              initialLink={searchParams.get("link") ?? undefined}
              sourceCommunicationId={searchParams.get("request") ?? undefined}
            />
          </div>

        </>
      )}
      {activeTab === "extraction" && <ExtractionPanel account={account} onChange={setAccount} />}
      {activeTab === "forms" && <FormsTab account={account} profile={profile} />}
      {activeTab === "certificates" && (
        <CertificatesTab account={account} profile={profile} sourceCommunicationId={searchParams.get("request") ?? undefined} />
      )}
      {activeTab === "activity" && <><LeadWorkflowPanel key={account.id} accountId={account.id} mode="history" /><Disclosure title="Record change history" description="Who changed account data, with the original values available for review"><ActivityTab accountId={account.id} /></Disclosure></>}
    </>
  );
}
