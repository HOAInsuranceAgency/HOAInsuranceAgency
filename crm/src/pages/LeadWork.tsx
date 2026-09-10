import { useState } from "react";
import { Link } from "react-router-dom";
import { LEAD_WORK_VIEWS, dueToday, workContext, type LeadWorkView } from "../../../shared/leadWorkViews";
import { useLastContacts } from "../lib/lastContact";
import { useWorkItems } from "../lib/communicationWork";
import { fmtDateTime, type UserProfile } from "../lib/client";
import { WorkPagination, SharedLeadAttention, LeadReminders } from "../components/LeadWorkExtras";

const descriptions: Record<LeadWorkView, string> = {
  "Needs attention": "Replies, callbacks, and work due today or overdue.",
  "Upcoming": "Scheduled follow-ups and other work due after today.",
  "All open": "Every open action, including future follow-ups.",
};
export default function LeadWork(_props: { profile: UserProfile }) {
  const [view, setView] = useState<LeadWorkView>("Needs attention");
  const [mine, setMine] = useState(false), [responsibility, setResponsibility] = useState("");
  const [revision, setRevision] = useState(0), [remindersOpen, setRemindersOpen] = useState(false);
  const work = useWorkItems("TASK", { view, mine, responsibility });
  const contacts = useLastContacts(work.data.items.flatMap(item => item.accountId ? [item.accountId] : []), work.data);
  const now = new Date().toISOString();
  async function refresh() { setRevision(n => n + 1); await work.refresh(); }
  return <div className="lead-work-page">
    <h1>Lead follow-up</h1><p className="sub">Know what needs attention and what happens next.</p>
    <div className="toolbar lead-work-filters">
      <label className="field">View<select value={view} onChange={e => setView(e.target.value as LeadWorkView)}>{LEAD_WORK_VIEWS.map(label => <option key={label}>{label}</option>)}</select></label>
      <label className="field">Responsibility<select value={responsibility} onChange={e => setResponsibility(e.target.value)}><option value="">All responsibilities</option><option value="SALESPERSON">Salesperson</option><option value="CHAMPION">Deal champion</option></select></label>
      <label className="lead-work-mine"><input type="checkbox" checked={mine} onChange={e => setMine(e.target.checked)} /> My leads</label>
      <div className="grow" /><button className="secondary" disabled={work.loading} onClick={() => void refresh()}>Refresh</button>
    </div>
    <p className="muted small">{descriptions[view]} Front snoozes never change these deadlines.</p>
    <section className="card" aria-label="Lead actions">
      {contacts.error && <p role="alert" className="error-text">{contacts.error}</p>}
      {work.error && <p role="alert" className="error-text">{work.error}</p>}
      {work.loading ? <p role="status">Loading actions…</p> : work.error ? null : !work.data.items.length ? <p className="muted">{work.data.nextToken ? "More actions remain to be checked. Continue searching to see matching work." : view === "Needs attention" ? "No actions need attention in this view." : "No matching open actions."}</p> :
        <div className="table-wrap"><table><thead><tr><th>Lead / next action</th><th>Responsibility</th><th>Last contact</th><th>Due</th><th>Timing</th></tr></thead>
          <tbody>{work.data.items.map(item => {
            const late = !!item.dueAt && Date.parse(item.dueAt) < Date.parse(now);
            const today = !!item.dueAt && dueToday(item.dueAt, now);
            return <tr key={item.id}>
              <td>{item.accountId ? <Link to={`/accounts/${item.accountId}`}>{item.name || "Open lead"}</Link> : "Lead needs linking"}
                <div className="lead-work-action">{item.title}</div>{item.kind && <span className="small muted">{workContext({ kind: item.kind, custom: item.custom })}</span>}</td>
              <td>{item.role === "CHAMPION" ? "Deal champion" : item.role === "SALESPERSON" ? "Salesperson" : "Team"}</td>
              <td>{!item.accountId ? "—" : contacts.loading ? "Loading…" : contacts.error ? "Unavailable" : contacts.contacts[item.accountId]?.at ? fmtDateTime(contacts.contacts[item.accountId]!.at) : "No contact recorded"}</td>
              <td>{fmtDateTime(item.dueAt)}</td>
              <td><span className={`badge ${late ? "red" : today ? "amber" : "gray"}`}>{late ? "Overdue" : today ? "Due today" : item.dueAt ? "Upcoming" : "Check due date"}</span>{item.escalatedAt && <small className="lead-work-escalation">Champion notified</small>}</td>
            </tr>;
          })}</tbody></table></div>}
      <WorkPagination work={work} />
    </section>
    {view !== "Upcoming" && <SharedLeadAttention key={revision} onChanged={() => void work.refresh()} />}
    <details className="card lead-work-reminders" onToggle={e => setRemindersOpen(e.currentTarget.open)}>
      <summary>My reminders</summary>
      {remindersOpen && <LeadReminders key={revision} />}
    </details>
  </div>;
}
