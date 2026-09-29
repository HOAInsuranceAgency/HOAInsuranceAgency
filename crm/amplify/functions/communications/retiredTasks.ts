/** Historical tasks remain stored; active task operations are permanently retired. */
export function tasksRemoved(): never { throw new Error("Tasks and follow-up scheduling have been removed from the CRM."); }

/** Explicit families whose task census or staff-report producer was removed. */
export function retiredTaskIssueId(id: string) {
  return /^issue:(?:task:|notice:|report:|morning-|coverage:|incumbent-date:|annual-date:|policy-handoff:|renewal-facts:|expired-risk:|bind-authorization:|op:(?:morning-summary|morning-reopen|reminder-comment|reopen:notice):|coverage-census$|contact-progress-repair$|report-setup$)/.test(id);
}

/** Keep unrelated delivery, assignment and renewal-context warnings actionable. */
export async function currentCommunicationIssue(
  item: { id: string; data: { resolved?: unknown; sourceId?: unknown } },
  loadSource: (id: string) => Promise<{ kind: string; data?: { type?: unknown; reminder?: unknown; reminderGroup?: unknown } } | undefined>,
) {
  if (item.data.resolved || retiredTaskIssueId(item.id)) return false;
  const source = typeof item.data.sourceId === "string" ? await loadSource(item.data.sourceId) : undefined;
  return !source || !["TASK", "NOTIFICATION", "REPORT_EDITION"].includes(source.kind)
    && !(source.kind === "OPERATION" && retiredReminderOperation(String(item.data.sourceId), source.data ?? {}));
}

/** Only historical task reminders, never ordinary comments or inbound reopens. */
export function retiredReminderOperation(id: string, data: { type?: unknown; reminder?: unknown; reminderGroup?: unknown }) {
  return ["COMMENT", "REOPEN"].includes(String(data.type)) && !!(data.reminderGroup || data.reminder ||
    /^op:(morning-summary|morning-reopen|reminder-comment|reopen:notice):/.test(id));
}
