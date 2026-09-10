/** Isolated visual preview: no credentials, network requests, or real writes. */
export type { LeadTask, WorkflowContext, TeamEligibility, Communication } from "../../../shared/leadWorkflow";
const context = {
  workflow: { accountId: "example", name: "Willow Court Condominium", salespersonId: "jake", championId: "jake", disposition: "ACTIVE", conversationId: "cnv_example", version: 1 },
  team: ["jake", "brian"].map(id => ({ userId: id, name: id === "jake" ? "Jake Greasley" : "Brian Cole", frontId: `tea_${id}`, enabled: true, salesperson: true, champion: true })),
  frontContext: { assigneeId: "tea_jake", routing: "SALESPERSON" }, issues: [],
  tasks: [{ id: "task", accountId: "example", title: "Follow up with prospect", role: "SALESPERSON", kind: "FOLLOW_UP", status: "OPEN", dueAt: "2026-09-14T13:00:00Z", version: 1 }],
  communications: [{ id: "message", accountId: "example", channel: "EMAIL", subject: "Your association's insurance review", at: "2026-09-10T12:47:00Z", text: "I'll review the current policy and get back to you with the next steps.", status: "SENT", direction: "OUTBOUND", provider: "front", providerId: "msg_example", actorId: "crm:initial-ai", to: ["jane@example.com"], version: 1 }],
};
export async function communicationRequest(op: string, input?: Record<string, string>) {
  if (op === "context") return structuredClone(context);
  if (op === "accountSummary") return { summary: { name: context.workflow.name, source: "website-ho6:willow-court", contacts: [{ id: "jane", name: "Jane Smith", email: "jane@example.com", phone: "(617) 555-0123" }], notes: "Please call after 3 p.m. We are reviewing the dwelling and loss assessment coverage.", quotes: [], documents: [], url: "https://example.com/lead", more: false } };
  if (op === "work") return { items: [] };
  if (op === "setResponsibilities") { context.workflow.salespersonId = input!.salespersonId; context.workflow.championId = input!.championId; }
  if (op === "smsComposer") return { channelId: "cha_example", sender: "+15085550123" };
  return { notice: "Preview only. No changes were saved." };
}
export const client = { models: { Account: { list: async () => ({ data: [{ id: "example", name: context.workflow.name }] }) } } };
export const fmtDateTime = (value: string) => new Date(value).toLocaleString("en-US");
export const fmtDate = (value: string) => new Date(value).toLocaleDateString("en-US");
export const fmtProviderPhone = (value: string) => value;
export const friendlyError = (error: unknown) => String(error);
export default {
  contextUpdates: { subscribe: (fn: (value: unknown) => void) => { const timer = setTimeout(() => fn({ conversation: { id: "cnv_example" } }), 0); return { unsubscribe: () => clearTimeout(timer) }; } },
  openUrl: () => {}, createDraft: async () => {},
};
