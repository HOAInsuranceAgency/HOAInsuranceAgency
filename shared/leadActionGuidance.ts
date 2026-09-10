import type { Communication, LeadTask } from "./leadWorkflow";
import { automaticContactTask } from "./contactProgress";

/** Same plain-language explanation in Front, the sidebar, and CRM reminders. */
export function leadActionGuidance(task: LeadTask, communications: Communication[] = [], escalated = !!task.escalatedAt) {
  const sources = communications.filter(c => task.sourceIds?.includes(c.id) || task.episode === c.id);
  const request = (sources.find(c => c.channel === "SMS" && c.text) ?? sources.find(c => c.direction === "INBOUND" && c.text))?.text?.replace(/\s+/g, " ").trim();
  const preview = request ? request.length > 180 ? `${request.slice(0, 177)}…` : request : undefined;
  let why: string, action: string;
  if (task.custom) {
    why = "Your team scheduled this next step."; action = task.title;
  } else if (task.kind === "CALLBACK") {
    why = "A prospect's missed call still needs a callback."; action = "Return the prospect's call";
  } else if (task.kind === "RESPONSE") {
    why = sources.some(c => c.channel === "SMS") ? "A prospect's text still needs a response." : "A prospect's message still needs a response.";
    action = "Respond to the prospect";
  } else if (task.kind === "CARRIER") {
    why = "A carrier's message needs your attention."; action = "Review and respond to the carrier";
  } else if (task.kind === "DOCUMENTS") {
    why = "Documents are still needed to move this lead forward."; action = task.title;
  } else if (task.kind === "CORRECTION") {
    why = "An email could not be delivered."; action = "Check the email address and arrange a response";
  } else if (task.kind === "FOLLOW_UP") {
    why = sources.some(c => c.channel === "CALL" && c.status === "MISSED") ? "Your last call was not answered. Try the prospect again."
      : (task.reminderAt ?? task.dueAt) > new Date().toISOString() ? "Follow-up is scheduled automatically after your last contact." : "There has been no reply since your last contact. It is time to follow up.";
    action = task.role === "CHAMPION" ? "Follow up with the carrier" : "Follow up with the prospect";
  } else {
    why = "This activity needs a team member's review."; action = task.title;
  }
  if (escalated) why = `This action is overdue and needs the deal champion's help. ${why}`;
  const after = !automaticContactTask(task)
    ? "Mark this step done when it is finished. The next follow-up is scheduled automatically."
    : task.kind === "CALLBACK" ? "Call through Dialpad. The call and next follow-up are tracked automatically."
    : "Reply in Front or call/text through Dialpad. Your activity and next follow-up are tracked automatically.";
  return { why, action, after, preview };
}
