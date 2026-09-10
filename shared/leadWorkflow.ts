/** Public, credential-free workflow contracts shared by the CRM and workers. */
export type Responsibility = "SALESPERSON" | "CHAMPION";
export type TaskKind = "FOLLOW_UP" | "RESPONSE" | "CALLBACK" | "CARRIER" | "DOCUMENTS" | "CORRECTION" | "TRIAGE";
export interface TeamEligibility {
  userId: string; name: string; email: string; enabled: boolean;
  salesperson: boolean; champion: boolean; frontId?: string; dialpadId?: string; version?: number;
}
export interface LeadWorkflow {
  accountId: string; name: string; salespersonId?: string; championId?: string;
  disposition: "ACTIVE" | "BOUND" | "LOST" | "DISQUALIFIED";
  conversationId?: string; assignmentIssue?: string; humanTakeover?: boolean;
  version: number; updatedAt: string;
}
export interface LeadTask {
  id: string; accountId: string; title: string; kind: TaskKind; role: Responsibility;
  dueAt: string; escalationAt: string; status: "OPEN" | "COMPLETE" | "CANCELLED";
  episode?: string; conversationId?: string; sourceAt?: string; custom?: boolean;
  sourceIds?: string[];
  reason?: string; notifiedAt?: string; escalatedAt?: string; version: number;
  notifiedRecipientId?: string; escalatedRecipientId?: string;
}
export interface Communication {
  id: string; accountId?: string; channel: "EMAIL" | "CALL" | "SMS" | "NOTE";
  provider: "front" | "dialpad" | "crm"; providerId: string; conversationId?: string;
  direction: "INBOUND" | "OUTBOUND" | "INTERNAL"; at: string; subject?: string;
  text?: string; from?: string; to?: string[]; actorId?: string; status: string;
  summary?: string; sourceUrl?: string; seenAt?: string; seenCheckedAt?: string; seenRequestedAt?: string;
  seenError?: string; classification?: "SUBSTANTIVE" | "AUTOMATIC" | "REVIEW";
  resolved?: boolean; workflowApplied?: boolean; version: number;
  attachments?: { id: string; filename: string; content_type: string; size: number }[];
  outcome?: string; outcomeBy?: string; outcomeAt?: string; enrichment?: string;
}
export interface IntegrationConfig {
  environment: string; defaultUserId?: string; holidays: string[]; paused: boolean;
  frontCompanyId?: string; frontInboxId?: string; frontChannelId?: string;
  frontSender: string; allowedInboxIds: string[]; testRecipients: string[];
  dialpadCompanyId?: string; dialpadOfficeId?: string; dialpadNumbers: string[];
  sharedSmsNumber: string; frontSmsChannelId?: string;
  activatedAt?: string; version: number;
}
export interface WorkflowContext {
  frontContext?: { conversationId: string; assigneeId?: string; routing?: string };
  workflow: LeadWorkflow | null; tasks: LeadTask[]; communications: Communication[];
  team: TeamEligibility[]; issues: { id: string; message: string; at: string }[];
  nextToken?: string; communicationNextToken?: string;
}

export function normalizePhone(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return value.trim().startsWith("+") && digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
}

const zone = "America/New_York";
const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
function parts(ms: number) {
  const p = Object.fromEntries(formatter.formatToParts(ms).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: +p.hour, minute: +p.minute };
}
function businessDate(day: string, holidays: readonly string[]) {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !holidays.includes(day);
}
function localHour(day: string, hour: number): number {
  const target = Date.parse(`${day}T${String(hour).padStart(2, "0")}:00:00Z`);
  let at = target;
  for (let i = 0; i < 3; i++) {
    const p = parts(at);
    const wall = Date.parse(`${p.day}T${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}:00Z`);
    at += target - wall;
  }
  return at;
}
function nextDate(day: string): string { return new Date(Date.parse(`${day}T12:00:00Z`) + 86400_000).toISOString().slice(0, 10); }
/** Eight staffed hours per business day, with exact seconds, holidays and DST. */
export function businessDeadline(from: string, days = 1, holidays: readonly string[] = []): string {
  let at = Date.parse(from), remaining = days * 8 * 3600_000;
  if (!Number.isFinite(at) || !Number.isInteger(days) || days < 1 || days > 30) throw new Error("Invalid business deadline");
  let day = parts(at).day;
  for (let i = 0; i < 120; i++, day = nextDate(day)) {
    if (!businessDate(day, holidays)) continue;
    const start = Math.max(at, localHour(day, 9)), end = localHour(day, 17);
    if (start >= end) continue;
    if (remaining <= end - start) return new Date(start + remaining).toISOString();
    remaining -= end - start;
  }
  throw new Error("Agency calendar has no available business time");
}
/** 9am on the Nth business date after the source date. */
export function followUpDeadline(from: string, days = 2, holidays: readonly string[] = []): string {
  if (!Number.isFinite(Date.parse(from)) || !Number.isInteger(days) || days < 1 || days > 30) throw new Error("Invalid follow-up date");
  let day = parts(Date.parse(from)).day, remaining = days;
  for (let i = 0; i < 120; i++) {
    day = nextDate(day);
    if (businessDate(day, holidays) && --remaining === 0) return new Date(localHour(day, 9)).toISOString();
  }
  throw new Error("Agency calendar has no available follow-up date");
}

export function mergeInboundDeadline(existing: LeadTask | undefined, incoming: LeadTask): LeadTask {
  if (!existing || existing.status !== "OPEN") return incoming;
  if (existing.custom) return existing;
  return { ...existing, dueAt: existing.dueAt < incoming.dueAt ? existing.dueAt : incoming.dueAt,
    escalationAt: existing.escalationAt < incoming.escalationAt ? existing.escalationAt : incoming.escalationAt };
}
export function canArchive(workflow: LeadWorkflow, tasks: LeadTask[], unresolved: boolean, unhealthy: boolean): boolean {
  if (!workflow.salespersonId || !workflow.championId || workflow.assignmentIssue || unresolved || unhealthy) return false;
  const open = tasks.filter(t => t.status === "OPEN");
  if (open.some(t => t.dueAt <= new Date().toISOString() || ["RESPONSE", "CALLBACK", "CORRECTION"].includes(t.kind))) return false;
  return workflow.disposition !== "ACTIVE" || open.length > 0;
}
