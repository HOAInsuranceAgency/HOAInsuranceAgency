/** Historical tasks remain stored; active task operations are permanently retired. */
export function tasksRemoved(): never { throw new Error("Tasks and follow-up scheduling have been removed from the CRM."); }

/** Explicit families whose task census or staff-report producer was removed. */
export function retiredTaskIssueId(id: string) {
  return /^issue:(?:task:|notice:|report:|morning-|coverage:|incumbent-date:|annual-date:|policy-handoff:|renewal-facts:|expired-risk:|bind-authorization:|op:(?:morning-summary|morning-reopen|reminder-comment|reopen:notice):|coverage-census$|contact-progress-repair$|report-setup$)/.test(id);
}

type CommunicationIssue = { id: string; data: { resolved?: unknown; sourceId?: unknown } };
type IssueSource = { kind: string; data?: { type?: unknown; reminder?: unknown; reminderGroup?: unknown } };

/** Keep unrelated delivery, assignment and renewal-context warnings actionable. */
function currentCommunicationIssue(item: CommunicationIssue, source?: IssueSource) {
  if (item.data.resolved || retiredTaskIssueId(item.id)) return false;
  return !source || !["TASK", "NOTIFICATION", "REPORT_EDITION"].includes(source.kind)
    && !(source.kind === "OPERATION" && retiredReminderOperation(String(item.data.sourceId), source.data ?? {}));
}

/** Batch unique sources before filtering; an incomplete read must fail, not hide a warning. */
export async function currentCommunicationIssues(
  items: readonly CommunicationIssue[],
  loadSources: (ids: string[]) => Promise<ReadonlyMap<string, IssueSource>>,
) {
  const ids = [...new Set(items.filter(item => !item.data.resolved && !retiredTaskIssueId(item.id))
    .flatMap(item => typeof item.data.sourceId === "string" && item.data.sourceId ? [item.data.sourceId] : []))];
  const sources = new Map<string, IssueSource>();
  // Account context/cleanup can contain more sources than a single DynamoDB batch.
  for (let offset = 0; offset < ids.length; offset += 100) {
    for (const [id, source] of await loadSources(ids.slice(offset, offset + 100))) sources.set(id, source);
  }
  return items.map(item => currentCommunicationIssue(item, typeof item.data.sourceId === "string" ? sources.get(item.data.sourceId) : undefined));
}

/** Only historical task reminders, never ordinary comments or inbound reopens. */
export function retiredReminderOperation(id: string, data: { type?: unknown; reminder?: unknown; reminderGroup?: unknown }) {
  return ["COMMENT", "REOPEN"].includes(String(data.type)) && !!(data.reminderGroup || data.reminder ||
    /^op:(morning-summary|morning-reopen|reminder-comment|reopen:notice):/.test(id));
}
