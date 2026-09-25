import { lazy, Suspense, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { dueToday, workContext, type LeadWorkView } from "../../../shared/leadWorkViews";
import { workLink } from "../../../shared/leadActionGuidance";
import { useWorkItems, type WorkItem } from "../lib/communicationWork";
import { fmtDateTime, type UserProfile } from "../lib/client";
import type { LeadTask } from "../lib/communications";
import { WorkPagination, SharedLeadAttention, LeadReminders } from "../components/LeadWorkExtras";
import { Disclosure, EmptyState, LoadingState, Pagination, SectionNav } from "../components/ui/kit";
import { useListPage } from "../lib/useListPage";

const Report = lazy(() => import("../components/MorningWorkReport"));
const Renewals = lazy(() => import("./dashboard/RenewalsTab"));
const CarrierWork = lazy(() => import("../components/MarketingTasks").then(m => ({ default: m.AllMarketingTasks })));
const SECTIONS = [["actions", "My actions"], ["carrier", "Carrier deadlines"], ["renewals", "Renewals"], ["team", "Team setup"], ["report", "Team report"]] as const;
type Section = typeof SECTIONS[number][0];

export default function LeadWork({ profile }: { profile: UserProfile }) {
  const [params, setParams] = useSearchParams();
  const requested = params.get("section") || (params.has("report") ? "report" : "actions");
  const section = SECTIONS.some(([key]) => key === requested) ? requested as Section : "actions";
  return <div className="lead-work-page">
    <div className="page-heading"><div><h1>My work</h1><p className="sub">Start with what is due. Find account information in Accounts.</p></div><Link className="button primary" to="/leads/new">New lead</Link></div>
    <SectionNav label="Work view" items={SECTIONS} value={section} onChange={value => { const next = new URLSearchParams(params); next.set("section", value); next.delete("report"); setParams(next); }} />
    <Suspense fallback={<LoadingState label="Loading work…" />}>
      {section === "actions" && <Actions />}
      {section === "carrier" && <><p className="muted">Agency-wide carrier submission deadlines. Assigned replies and follow-ups are in My actions.</p><CarrierWork completedByName={`${profile.firstName} ${profile.lastName}`} /></>}
      {section === "renewals" && <><p className="muted">Agency-wide renewal planning. Use My actions for work assigned to you.</p><Renewals /></>}
      {section === "team" && <><p className="muted">Shared setup and unlinked activity. These items are separate from your assigned actions.</p><SharedLeadAttention onChanged={() => {}} /></>}
      {section === "report" && <Report />}
    </Suspense>
  </div>;
}

function Actions() {
  const [view, setView] = useState<LeadWorkView>("Needs attention");
  const [mine, setMine] = useState(true), [responsibility, setResponsibility] = useState("");
  const [query, setQuery] = useState("");
  const work = useWorkItems("TASK", { view, mine, responsibility });
  const now = new Date().toISOString();
  const matching = work.data.items.filter(i => `${i.name ?? ""} ${i.title ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  const grouped = new Map<string, WorkItem[]>();
  for (const item of matching) { const key = item.accountId ?? item.id; grouped.set(key, [...(grouped.get(key) ?? []), item]); }
  const groups = [...grouped.values()].map(items => items.sort((a,b) => (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999"))).sort((a,b) => (a[0].dueAt ?? "9999").localeCompare(b[0].dueAt ?? "9999"));
  const list = useListPage(groups, JSON.stringify([view, mine, responsibility, query]), 12);
  return <>
    <div className="view-tools card">
      <label className="field">Scope<select value={mine ? "mine" : "all"} onChange={e => setMine(e.target.value === "mine")}><option value="mine">Assigned to me</option><option value="all">All permitted team actions</option></select></label>
      <label className="field">When<select value={view} onChange={e => setView(e.target.value as LeadWorkView)}><option value="Needs attention">Due now</option><option value="Upcoming">Scheduled</option><option value="All open">All open actions</option></select></label>
      <label className="field">Responsibility<select value={responsibility} onChange={e => setResponsibility(e.target.value)}><option value="">All responsibilities</option><option value="SALESPERSON">Salesperson</option><option value="CHAMPION">Deal champion</option></select></label>
      <label className="field">Find in loaded work<input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Account or action" /></label>
      <button className="secondary" disabled={work.loading} onClick={() => void work.refresh()}>Refresh</button>
    </div>
    <p className="muted small">{mine ? "Your assigned actions" : "All team actions you can access"} · {view === "Needs attention" ? "due today or overdue" : view === "Upcoming" ? "due after today" : "including future commitments"}. Times are Eastern. {work.data.nextToken && "More actions are available below; counts cover loaded work."}</p>
    {work.error && <p role="alert" className="error-text">{work.error} <button onClick={() => void work.refresh()}>Retry</button></p>}
    {work.loading ? <LoadingState label="Checking your actions…" /> : !work.error && <>
      {!groups.length && <EmptyState title={work.data.nextToken ? "No matches in this part of the queue" : "No matching actions in this view"}>{work.data.nextToken ? "Continue loading to check the remaining work." : "Try Scheduled or change the scope. Shared setup is kept in Team setup."}</EmptyState>}
      <div className="record-list work-grid">{list.rows.map(items => <article className="card" key={items[0].accountId ?? items[0].id}><h2>{items[0].accountId ? <Link to={`/accounts/${items[0].accountId}`}>{items[0].name || "Open account"}</Link> : "Account needs linking"} <span className="muted small">{items.length} action{items.length === 1 ? "" : "s"}</span></h2>{items.map((item, index) => {
        const link = item.kind && item.accountId ? workLink(item as LeadTask) : null;
        const action = <div className="record-card"><strong>{item.title}</strong><p className="record-meta">{item.kind && workContext({ kind: item.kind, custom: item.custom })}{item.term && ` · Coverage ${item.term}`} · {item.role === "CHAMPION" ? "Deal champion" : item.role === "SALESPERSON" ? "Salesperson" : "Team"}</p><p><span className={`badge ${item.dueAt && item.dueAt < now ? "red" : "gray"}`}>{item.dueAt && item.dueAt < now ? "Overdue" : item.dueAt && dueToday(item.dueAt, now) ? "Due today" : "Scheduled"}</span> {fmtDateTime(item.dueAt)}{item.escalatedAt && <span className="small muted"> · Manager escalation</span>}</p>{link && <div className="record-action">{link.path.startsWith("https://") ? <a href={link.path} target="_blank" rel="noreferrer">{link.label} ↗</a> : <Link to={link.path}>{link.label} →</Link>}</div>}</div>;
        return index < 2 ? <div key={item.id}>{action}</div> : <details key={item.id}><summary>{item.title} · {fmtDateTime(item.dueAt)}</summary>{action}</details>;
      })}</article>)}</div>
      <Pagination total={groups.length} page={list.page} onPage={list.setPage} size={list.size} noun="accounts" />
      <WorkPagination work={work} />
    </>}
    <Disclosure title="My reminder history"><LeadReminders /></Disclosure>
  </>;
}
