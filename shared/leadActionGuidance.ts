import type { Communication, LeadTask } from "./leadWorkflow";
import { taskDomain, taskContext } from "./workRouting";

/** The same actionable explanation in the work list, Front and morning report. */
export function leadActionGuidance(task: LeadTask, communications: Communication[] = [], escalated = !!task.escalatedAt) {
  const sources = communications.filter(c => task.sourceIds?.includes(c.id) || task.episode === c.id);
  const request = (sources.find(c => c.direction === "INBOUND" && c.text))?.text?.replace(/\s+/g, " ").trim();
  const preview = request ? request.length > 180 ? `${request.slice(0, 177)}…` : request : undefined;
  const person = taskDomain(task) === "CARRIER" ? "carrier" : taskContext(task) === "LEAD" ? "prospect" : "client";
  const labels: Record<LeadTask["kind"], [string, string]> = {
    FIRST_CONTACT: ["This lead has not received its first outreach.", "Make first contact"],
    ANNUAL_RETURN: ["The next renewal opportunity is 90 days away. This lead is ready to revisit.", "Reconnect with the prospect"],
    RESPONSE: [`A ${person}'s message needs a response.`, `Respond to the ${person}`],
    CALLBACK: [`A ${person}'s missed call needs a return attempt.`, `Return the ${person}'s call`],
    CARRIER: ["A carrier has requested an answer.", "Respond to the carrier"],
    FOLLOW_UP: [sources.some(c => c.channel === "CALL" && c.status === "MISSED") ? "The last call was not answered. A further attempt is due." : `The ${person} has not replied to the last request.`, `Follow up with the ${person}`],
    PROSPECT_UPDATE: ["Carrier work is progressing and the prospect is due an update.", "Keep the prospect informed"],
    RENEWAL_START: ["The policy is entering its renewal preparation window.", "Start renewal preparation"],
    SUBMISSION: ["The carrier's submission deadline is approaching.", task.title],
    QUOTE_TARGET: ["Usable quotes for the required term and coverage are still missing.", "Obtain usable quotes before expiration"],
    QUOTE_PRESENTATION: ["A usable quote is ready for the client to review.", "Present the quote"],
    DOCUMENTS: ["Requested information is still needed to move this work forward.", task.title],
    BIND: ["Accepted coverage still needs its binding or carrier confirmation.", task.title],
    SERVICE: ["A client request needs coordination or final delivery.", task.title],
    CORRECTION: ["A communication could not be delivered.", "Correct the contact details and arrange a response"],
    TRIAGE: ["Incoming activity needs the correct account and responsible person.", "Link the incoming activity"],
  };
  let [why, action] = task.custom ? ["Your team made this commitment; its original deadline is preserved.", task.title] : labels[task.kind];
  if (task.shortTimeline && task.businessDueAt) why += ` This arrived after the original target of ${new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }).format(new Date(task.businessDueAt))}; review the remaining time to expiration.`;
  if (escalated) why = `This required work is overdue. The responsible manager needs to help recover it. ${why}`;
  if (task.helperId) why = `${task.helperReason === "MANAGER_COVER" ? "The manager is covering this response." : "The salesperson asked the champion to help with this request."} ${why}`;
  const after = task.milestone ? "Use the existing quote, policy or document workflow. Its business record updates this reminder."
    : task.custom ? "Keep the original business commitment. Actual communication is recorded automatically."
    : task.kind === "CALLBACK" ? "Call through Dialpad. A completed attempt is recorded and the next retry is scheduled automatically."
    : "Reply in Front or call/text through Dialpad. Your activity and the next follow-up are tracked automatically.";
  return { why, action, after, preview };
}
