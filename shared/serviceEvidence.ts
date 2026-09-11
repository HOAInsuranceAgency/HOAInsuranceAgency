import { contactProgress, contactAt, sameContact } from "./contactProgress";
import type { Communication, LeadTask } from "./leadWorkflow";
/** Only the new portion of a message can describe the current request/result. */
export function currentMessage(text = "") {
  return text.split(/\n(?:On .{3,200}wrote:|From:|[-_]{5,}|>)/i)[0].trim();
}
export function serviceRequestType(comm: Communication): NonNullable<LeadTask["serviceType"]> {
  const text = `${comm.subject ?? ""}\n${currentMessage(comm.text)}`;
  if (/\b(certificate of insurance|certificate|COI|ACORD 25)\b/i.test(text)) return "CERTIFICATE";
  if (/\b(endorsement|policy document|copy of (?:the |my |our )?policy)\b/i.test(text)) return "DOCUMENT";
  return "GENERAL";
}
/** Acknowledging/forwarding a request is outreach, not final service delivery. */
export function interimResponse(comm: Communication) {
  const body = currentMessage(comm.channel === "CALL" ? comm.text ?? comm.summary : comm.text);
  if (!body) return true;
  if (/\b(will (?:check|look|follow up|review|get back|ask)|looking into|working on|forward(?:ed|ing) (?:this|your)|awaiting|waiting (?:on|for)|received your request|let me (?:check|look|ask))\b/i.test(body)) return true;
  const plain = body.replace(/^(?:hi|hello|dear) [^\n,]+[,\n]\s*/i, "").replace(/\n(?:thanks|regards|best|sincerely)[\s\S]*$/i, "").trim();
  return /^(?:(?:thank(?:s| you)|received|got it|noted|okay|ok)[\s!.,]*)+$/i.test(plain);
}
export function deliveredServiceResponse(source: Communication, response: Communication) {
  return contactProgress(response) === "CONTACT" && response.actorId !== "crm:initial-ai"
    && sameContact(source, response) && contactAt(response) > source.at && !interimResponse(response);
}
