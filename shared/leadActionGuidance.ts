import type { Communication, LeadTask } from "./leadWorkflow";
import { taskDomain, taskContext } from "./workRouting";
import { currentMessage } from "./serviceEvidence";

export const agencyDay = (at: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
export const canTakeResponse = (task: Pick<LeadTask, "kind" | "milestone">) => !task.milestone && ["RESPONSE", "CALLBACK", "CARRIER"].includes(task.kind);
export function workLink(task: LeadTask): { path: string; label: string } {
  const account = `/accounts/${encodeURIComponent(task.accountId)}`;
  if (task.blocker) return { path: `${account}?tab=overview#lead-workspace`, label: "Review blocker" };
  if (task.kind === "CORRECTION") return { path: `${account}?tab=overview#contacts`, label: "Check contact details" };
  if (task.serviceType === "CERTIFICATE") return { path: `${account}?tab=certificates`, label: "Prepare certificate" };
  if (task.kind === "DOCUMENTS" || task.serviceType === "DOCUMENT") return { path: `${account}?tab=documents`, label: "Review documents" };
  if (["SUBMISSION", "QUOTE_TARGET", "QUOTE_PRESENTATION", "BIND"].includes(task.kind) || task.quoteId) return { path: `${account}?tab=quotes${task.kind === "SUBMISSION" ? "#carrier-work" : ""}`, label: task.kind === "SUBMISSION" ? "Review carrier submissions" : "Review quotes" };
  // Resolve renewal preparation against the account's current stage at the
  // destination, rather than assuming that every renewal task is a client.
  if (task.kind === "RENEWAL_START") return { path: `${account}?tab=renewal`, label: "Review renewal" };
  if (task.policyId) return { path: `${account}?tab=policies`, label: "Review renewal" };
  if (task.conversationId) return { path: `https://app.frontapp.com/open/${encodeURIComponent(task.conversationId)}`, label: task.kind === "CALLBACK" ? "Open call request" : "Open conversation" };
  return { path: `${account}?tab=overview#lead-workspace`, label: "Open lead workspace" };
}

/** The same actionable explanation in the work list, Front and morning report. */
export function leadActionGuidance(task: LeadTask, communications: Communication[] = [], escalated = !!task.escalatedAt, now = new Date().toISOString()) {
  const sources = communications.filter(c => task.sourceIds ? task.sourceIds.includes(c.id) : task.episode === c.id);
  const request = currentMessage(sources.find(c => c.direction === "INBOUND" && c.text)?.text).split(/\n\s*(?:Sent from my (?:iPhone|iPad)|Get Outlook for|On .{3,200}wrote:)/i)[0].replace(/\s+/g, " ").trim();
  const preview = request ? request.length > 180 ? `${request.slice(0, 177)}…` : request : undefined;
  const person = taskDomain(task) === "CARRIER" ? "carrier" : taskContext(task) === "LEAD" ? "prospect" : "client";
  const labels: Record<LeadTask["kind"], [string, string]> = {
    FIRST_CONTACT: ["No qualifying outreach is recorded in the linked CRM history yet.", "Contact the prospect or check their latest conversation"],
    ANNUAL_RETURN: ["The next renewal opportunity is 90 days away. This lead is ready to revisit.", "Reconnect with the prospect"],
    RESPONSE: [`A ${person}'s message needs a response.`, `Respond to the ${person}`],
    CALLBACK: [`A ${person}'s missed call needs a return attempt.`, `Return the ${person}'s call`],
    CARRIER: ["A carrier has requested an answer.", "Respond to the carrier"],
    FOLLOW_UP: [sources.some(c => c.channel === "CALL" && c.status === "MISSED") ? "The last call was not answered. A further attempt is due." : `The ${person} has not replied to the last request.`, `Follow up with the ${person}`],
    PROSPECT_UPDATE: ["Carrier work is progressing and the prospect is due an update.", "Keep the prospect informed"],
    RENEWAL_START: ["The policy is entering its renewal preparation window.", "Start renewal preparation"],
    SUBMISSION: [task.dueAt < now ? "The recorded carrier submission target has passed; submission is still unconfirmed." : agencyDay(task.dueAt) === agencyDay(now) ? "The carrier submission is due today." : "A carrier submission is coming due.", task.title],
    QUOTE_TARGET: ["Usable quotes for the required term and coverage are still missing.", "Obtain usable quotes before expiration"],
    QUOTE_PRESENTATION: ["A usable quote is ready for the client to review.", "Present the quote"],
    DOCUMENTS: ["Requested information is still needed to move this work forward.", task.title],
    BIND: ["Accepted coverage still needs its binding or carrier confirmation.", task.title],
    SERVICE: ["A client request needs coordination or final delivery.", task.title],
    CORRECTION: ["A communication could not be delivered.", "Correct the contact details and arrange a response"],
    TRIAGE: ["Incoming activity needs the correct account and responsible person.", "Link the incoming activity"],
  };
  let [why, action] = task.custom ? ["Your team made this commitment; its original deadline is preserved.", task.title] : labels[task.kind];
  if (task.term && ["SUBMISSION", "QUOTE_TARGET", "RENEWAL_START", "BIND"].includes(task.kind)) {
    if (task.term < agencyDay(now)) { why = `The required coverage date (${task.term}) has passed. Confirm current coverage and the remaining placement work.`; action = "Confirm current placement status"; }
    else if (task.term === agencyDay(now)) why = `Coverage is needed today. Confirm placement and any outstanding carrier requirements.`;
  }
  if (task.shortTimeline && task.businessDueAt) why += ` The original target was ${new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }).format(new Date(task.businessDueAt))}.`;
  if (escalated) why = `This required work is overdue. The responsible manager needs to help recover it. ${why}`;
  if (task.helperId) why = `${task.helperReason === "MANAGER_COVER" ? "The manager is covering this response." : "The salesperson asked the champion to help with this request."} ${why}`;
  if (task.blocker) { why = `${task.blocker.reason}${task.blocker.detail ? `: ${task.blocker.detail.replace(/[.!?]+$/, "")}` : ""}. The original commitment remains tracked.`; action = "Review the business blocker"; }
  const after = task.blocker ? "The named owner reviews this at 9 a.m. Client updates and the original deadline remain in effect."
    : task.kind === "CORRECTION" ? "Verify the address or use the business phone. Do not repeat an email to an address that is still bouncing."
    : task.kind === "SUBMISSION" ? "Review the selected market and submit through the existing carrier workflow. Its submission record updates this reminder."
    : task.kind === "QUOTE_TARGET" ? "Review carrier responses and record usable quote terms in Quotes. An email alone cannot confirm a usable quote."
    : task.milestone ? "Use the existing quote, policy or document workflow. Its business record updates this reminder."
    : task.custom ? "Keep the original business commitment. Actual communication is recorded automatically."
    : task.kind === "CALLBACK" ? "Call through Dialpad. A completed attempt is recorded and the next retry is scheduled automatically."
    : "Reply in Front or call/text through Dialpad. Your activity and the next follow-up are tracked automatically.";
  return { why, action, after, preview };
}
