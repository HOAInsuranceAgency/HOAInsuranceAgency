import { acquisitionLabel, cleanAttribution, isLeadSource } from "./leadSource";
import { accountPropertyType, propertyTypeLabel, webLeadPropertyType } from "./propertyType";

/** A read-only snapshot. Workers unwrap communication-store rows before calling. */
export type ReportRecord = { id?: string | null; [key: string]: unknown };
export interface ReportSnapshot {
  accounts: ReportRecord[]; quotes: ReportRecord[]; policies: ReportRecord[];
  priorCarriers: ReportRecord[]; carriers: ReportRecord[]; documents: ReportRecord[]; activities: ReportRecord[];
  workflows: ReportRecord[]; communications: ReportRecord[]; tasks: ReportRecord[]; submissions: ReportRecord[];
}
export type ReportCell = string | number | Date | null;
export interface MarketingLeadReport { headers: readonly string[]; rows: ReportCell[][]; asOf: string; warnings: string[] }
export const MARKETING_REPORT_TIMEZONE = "America/New_York";
/** Template layout with marketing's property classification and unit-count update. */
export const MARKETING_REPORT_HEADERS = [
  "Lead ID", "Lead Name", "State", "Property Type", "Property Units", "Status", "Status Group", "Status Definition", "Source",
  "Source Channel Group", "Channel", "Paid Source", "Attribution Confidence", "Coverage Segment", "Coverage Family",
  "Line of Business", "Coverage Requested", "Stated Carrier", "Inquiry Date", "First Agency Contact Date",
  "First Client Reply Date", "Docs First Received Date", "Quote Issued Date", "Bound Date", "Lost Date",
  "Last Client Response Date", "Last Client Response Note", "Last Agency Outbound Date", "Email Tracking Status",
  "Docs Received", "Docs Detail", "Docs Outstanding", "Quote Issued", "Quote Carrier", "Quote Amount ($)",
  "Premium on Record ($)", "Premium Category", "In Incumbent Average", "Premium Basis", "Premium Note",
  "Other Premium on Record", "Policy Expiration Date", "Expiration Confidence", "Hold Reason", "Quote Lead",
  "Excluded", "Exclusion Reason", "Lead Age (Days)", "Days to Last Client Response", "Days Since Last Client Response",
  "Days Since Last Agency Outbound", "Stalled", "Notes",
] as const;
const missing = "Not recorded", dayMs = 86_400_000;
const text = (r: ReportRecord | undefined, key: string) => typeof r?.[key] === "string" ? (r[key] as string).trim() : "";
const number = (r: ReportRecord | undefined, key: string) => typeof r?.[key] === "number" && Number.isFinite(r[key]) && (r[key] as number) >= 0 ? r[key] as number : null;
const object = (v: unknown): ReportRecord => v && typeof v === "object" && !Array.isArray(v) ? v as ReportRecord : {};
const list = (r: ReportRecord | undefined, key: string): string[] => Array.isArray(r?.[key]) ? (r[key] as unknown[]).filter((v): v is string => typeof v === "string" && !!v.trim()) : [];
const unique = (values: string[]) => [...new Set(values.filter(Boolean))];
function safeNote(value: string, maximum = 280): string {
  const clean = value.replace(/https?:\/\/\S+/gi, "[link omitted]");
  return clean.length > maximum ? `${clean.slice(0, maximum)}… [Excerpt; full details in CRM.]` : clean;
}
function instant(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) return null;
  const calendar = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== value.slice(0, 10)) return null;
  const ms = Date.parse(value); return Number.isFinite(ms) ? ms : null;
}
function known(value: unknown, cutoff: number): string | null { const ms = instant(value); return ms !== null && ms <= cutoff ? value as string : null; }
function localDay(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: MARKETING_REPORT_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
const dateCell = (value: string | null | undefined): Date | null => value && instant(value) !== null ? new Date(`${localDay(value)}T00:00:00.000Z`) : null;
function days(from: string | null | undefined, to: string | null | undefined): number | null {
  if (!from || !to || instant(from) === null || instant(to) === null || Date.parse(to) < Date.parse(from)) return null;
  return Math.round((Date.parse(localDay(to)) - Date.parse(localDay(from))) / dayMs);
}
const byTime = (a: { at: string }, b: { at: string }) => Date.parse(a.at) - Date.parse(b.at);
const presentBy = (r: ReportRecord, asOf: number) => !text(r, "createdAt") || !!known(r.createdAt, asOf);
/** Index each source once, rather than rescanning the full database for every account. */
function byAccount(rows: ReportRecord[], key: "accountId" | "entityId", cutoff: number): Map<string, ReportRecord[]> {
  const index = new Map<string, ReportRecord[]>();
  for (const row of rows) {
    const id = text(row, key);
    if (!id || !presentBy(row, cutoff)) continue;
    const group = index.get(id);
    if (group) group.push(row); else index.set(id, [row]);
  }
  return index;
}
function activityChanges(r: ReportRecord): ReportRecord[] {
  let changes = r.changes;
  if (typeof changes === "string") { try { changes = JSON.parse(changes); } catch { return []; } }
  return Array.isArray(changes) ? changes.map(object) : [];
}
function transition(activities: ReportRecord[], subjectId: string, field: string, to: string, asOf: number, latest = false): string | null {
  return activities.filter(a => text(a, "subjectId") === subjectId && known(a.occurredAt, asOf) && activityChanges(a).some(c => text(c, "field") === field && text(c, "to") === to))
    .map(a => text(a, "occurredAt")).sort((a, b) => latest ? Date.parse(b) - Date.parse(a) : Date.parse(a) - Date.parse(b))[0] ?? null;
}

/** Only completed human prospect contacts; drafts, carrier activity and automation are not evidence. */
function humanContact(c: ReportRecord, cutoff: number): { row: ReportRecord; at: string } | null {
  const direction = text(c, "direction"), channel = text(c, "channel"), status = text(c, "status");
  if (!["INBOUND", "OUTBOUND"].includes(direction) || !["EMAIL", "SMS", "CALL"].includes(channel)
    || c.frontDraft || c.internalReport || ["AUTOMATIC", "REVIEW"].includes(text(c, "classification"))
    || text(c, "purpose") === "CARRIER" || text(c, "domain") === "CARRIER" || ["RENEWAL", "SERVICE"].includes(text(c, "context"))
    || ["UNRELATED", "WRONG_NUMBER"].includes(text(c, "outcome")) || text(c, "actorId").startsWith("crm:")
    || ["FAILED", "REJECTED", "UNDELIVERED", "IN_PROGRESS", "QUEUED", "PENDING", "DRAFT"].includes(status)) return null;
  // Email needs explicit prospect linkage; merely sharing an account is not enough.
  if (channel === "EMAIL" && text(c, "purpose") !== "PROSPECT" && text(c, "domain") !== "CLIENT") return null;
  if (channel === "CALL") {
    if (status !== "CONNECTED" || !known(c.endedAt, cutoff)) return null;
  } else {
    if (direction === "OUTBOUND" && !["SENT", "DELIVERED"].includes(status)) return null;
    if (direction === "INBOUND" && !["RECEIVED", "DELIVERED"].includes(status)) return null;
    if (!text(c, "text") && !(Array.isArray(c.attachments) && c.attachments.length)) return null;
  }
  const at = known(channel === "CALL" ? c.endedAt : c.at, cutoff);
  return at ? { row: c, at } : null;
}

function attribution(account: ReportRecord): string[] {
  const source = text(account, "leadSource"), legacy = text(account, "source"), a = cleanAttribution(account.leadAttribution);
  const paid = /^(cpc|ppc|paid|paid[_ -]?social|paid[_ -]?search|display|cpm)$/i.test(a.utm_medium ?? "");
  const google = !!(a.gclid || a.gbraid || a.wbraid) || paid && /^(google|googleads|google_ads|adwords)$/i.test(a.utm_source ?? "");
  const meta = paid && /^(meta|facebook|instagram|fb|ig)$/i.test(a.utm_source ?? "");
  if (google) return [acquisitionLabel(source, legacy), "Website", "Paid Search", "Y", "High"];
  if (meta) return [acquisitionLabel(source, legacy), "Website", "Paid Social", "Y", "High"];
  if (source === "GOOGLE_AD_WEBSITE" || source === "META_AD") return [acquisitionLabel(source, legacy), "Website", source === "META_AD" ? "Paid Social" : "Paid Search", "Y", "Medium"];
  // ORGANIC_WEBSITE is also the intake default when attribution is absent. It does not prove organic search.
  if (source === "ORGANIC_WEBSITE" || legacy.toLowerCase().startsWith("website")) return ["Website - attribution unverified", "Website", missing, missing, "Low"];
  if (isLeadSource(source)) return [acquisitionLabel(source, legacy), "Offline", source === "PHONE" ? "Phone" : source === "EMAIL" ? "Email" : "Property Manager", missing, "Medium"];
  return [acquisitionLabel(source, legacy), missing, missing, missing, missing];
}
function coverage(lines: string[]): string[] {
  const scope = lines.join("; "), personal = /HO[- ]?6|Homeowners|Personal|Condo Unit/i.test(scope), property = /Property|Businessowners|BOP|Package/i.test(scope);
  const liability = /Liability|D&O|Directors|Umbrella|Excess|Crime|Fidelity/i.test(scope);
  return personal ? ["Quoted individual coverage; full request unverified", "Personal Lines", "Personal Lines"] : property ? ["Quoted property coverage; full request unverified", "Property", "Commercial Lines"]
    : liability ? ["Quoted liability coverage; full request unverified", "Liability", "Commercial Lines"] : [missing, missing, missing];
}
function currentTerm(r: ReportRecord, asOf: string): boolean {
  const start = text(r, "effectiveDate"), end = text(r, "expirationDate"), day = localDay(asOf);
  return instant(start) !== null && instant(end) !== null && start.slice(0, 10) <= day && end.slice(0, 10) >= day && !["CANCELLED", "EXPIRED", "VOID"].includes(text(r, "status"));
}

export function buildMarketingLeadReport(snapshot: ReportSnapshot, asOf: string): MarketingLeadReport {
  const cutoff = instant(asOf); if (cutoff === null) throw new Error("A valid report timestamp is required");
  const warnings = [
    "Cumulative CRM snapshot: one row per lead or client account. Stable CRM IDs are used; spreadsheet-only historical IDs and manual annotations are not imported.",
    "Not recorded means the CRM has no verified value; blank numeric and date cells are unknown, not zero. Missing records are not negative answers.",
    "Property type uses the recorded CRM classification, Personal (HO-6) account type, or explicit website property-type answers. An association name alone does not establish its type. Conflicting intake answers require review. Property units uses the recorded account unit count; unknown counts are blank and individual owners are not assumed to have one unit.",
    "Inquiry date uses the earliest known inquiry or account creation. Contact dates use verified human prospect activity only; first client reply follows agency contact. Imported and untracked history may be incomplete.",
    "Quote issued means presented to the client, not merely received from a carrier. Quote date, carrier and amount refer to one selected quote; missing presentation dates remain blank.",
    "Premiums retain their origin and are never added across policies or coverage types. Incumbent average membership requires manual validation and is not inferred.",
    "Dropped off requires a verified client reply, then two unanswered human contacts in that conversation, then seven full days after the second. Calls must be connected. The template's separate editorial Stalled flag is not stored in the CRM and remains Not recorded.",
    "Editorial judgments such as competitor loss, exclusions, inquiry-only status and attribution confidence beyond recorded evidence require CRM data. Organic Website alone does not establish organic search.",
    "Dates and day counts use America/New_York. This snapshot describes current records as of generation and does not reconstruct historical states.",
    "Completed staff-filed input documents count as available. Their filing dates are not treated as client receipt dates. First receipt uses only known portal or inbound-message evidence; earlier untracked receipt may be unknown.",
  ];
  const carriers = new Map(snapshot.carriers.map(c => [text(c, "id"), text(c, "name")]));
  const index = {
    quotes: byAccount(snapshot.quotes, "accountId", cutoff), policies: byAccount(snapshot.policies, "accountId", cutoff),
    priorCarriers: byAccount(snapshot.priorCarriers, "accountId", cutoff), documents: byAccount(snapshot.documents, "entityId", cutoff),
    activities: byAccount(snapshot.activities, "entityId", cutoff), workflows: byAccount(snapshot.workflows, "accountId", cutoff),
    communications: byAccount(snapshot.communications, "accountId", cutoff), tasks: byAccount(snapshot.tasks, "accountId", cutoff),
    submissions: byAccount(snapshot.submissions, "accountId", cutoff),
  };
  const rows = snapshot.accounts.filter(a => ["LEAD", "CLIENT"].includes(text(a, "stage")) && presentBy(a, cutoff))
    .sort((a, b) => text(a, "name").localeCompare(text(b, "name")) || text(a, "id").localeCompare(text(b, "id"))).map(account => {
      const id = text(account, "id"), notes: string[] = [];
      let propertyType = accountPropertyType(account);
      if (!propertyType && !text(account, "propertyType") && text(account, "type") === "ASSOCIATION") {
        const intakeTypes = new Set((index.submissions.get(id) ?? []).filter(s => known(s.createdAt, cutoff))
          .flatMap(s => [s.propertyKind, s.answerPropertyKind].map(propertyKind => webLeadPropertyType({ type: account.type, propertyKind })).filter(t => t !== null)));
        if (intakeTypes.size === 1) {
          propertyType = [...intakeTypes][0];
          notes.push("Property type from the recorded website response.");
        } else if (intakeTypes.size > 1) notes.push("Conflicting website property types; record the confirmed property type in the CRM.");
      }
      const recordedUnits = number(account, "unitCount");
      const propertyUnits = Number.isSafeInteger(recordedUnits) ? recordedUnits : null;
      const activities = index.activities.get(id) ?? [];
      const quotes = (index.quotes.get(id) ?? []).filter(q => !text(q, "renewalPolicyId"));
      const policies = index.policies.get(id) ?? [];
      const workflow = index.workflows.get(id)?.[0];
      const tasks = (index.tasks.get(id) ?? []).filter(t => text(t, "status") === "OPEN" && text(t, "domain") !== "CARRIER" && !["SERVICE", "RENEWAL"].includes(text(t, "context")));
      const communications = index.communications.get(id) ?? [];
      const contacts = communications.map(c => humanContact(c, cutoff)).filter((c): c is NonNullable<typeof c> => !!c).sort(byTime);
      const inbound = contacts.filter(c => text(c.row, "direction") === "INBOUND"), outbound = contacts.filter(c => text(c.row, "direction") === "OUTBOUND");
      const firstOut = outbound[0], lastOut = outbound.at(-1);
      const created = known(account.createdAt, cutoff), firstInbound = inbound[0]?.at;
      const inquiry = [created, firstInbound].filter((v): v is string => !!v).sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
      const replies = firstOut ? inbound.filter(c => Date.parse(c.at) > Date.parse(firstOut.at)) : [];
      const firstReply = replies[0], lastReply = replies.at(-1);
      const unanswered = lastReply ? outbound.filter(c => Date.parse(c.at) > Date.parse(lastReply.at)
        && !!text(c.row, "conversationId") && text(c.row, "conversationId") === text(lastReply.row, "conversationId")) : [];
      // Distinct events at the same timestamp may be duplicated provider deliveries, not two followups.
      const followups = unique(unanswered.map(c => c.at));
      const stalled = followups.length >= 2 ? cutoff - Date.parse(followups[1]) >= 7 * dayMs : false;
      const presented = quotes.map(q => ({ q, at: known(q.presentedAt, cutoff) ?? transition(activities, text(q, "id"), "status", "PRESENTED", cutoff) }))
        .filter(p => p.at || (!text(p.q, "presentedAt") && ["PRESENTED", "BOUND"].includes(text(p.q, "status"))))
        .sort((a, b) => (b.at ? Date.parse(b.at) : -Infinity) - (a.at ? Date.parse(a.at) : -Infinity) || text(a.q, "id").localeCompare(text(b.q, "id")));
      // Multiple undated presentations cannot be ordered without inventing a date.
      const selectionAmbiguous = presented.length > 1 && presented.some(p => !p.at);
      const selected = selectionAmbiguous ? undefined : presented[0], quote = selected?.q;
      if (selectionAmbiguous) notes.push("Multiple presented quotes include unknown presentation dates; quote selection needs review.");
      if (presented.length && !selected?.at) notes.push("Presentation date not recorded.");
      const bound = text(account, "stage") === "CLIENT" || text(workflow, "disposition") === "BOUND" || quotes.some(q => text(q, "status") === "BOUND") || policies.some(p => ["ACTIVE", "BOUND"].includes(text(p, "status")));
      const lost = !bound && text(workflow, "disposition") === "LOST";
      const blockers = tasks.map(t => object(t.blocker)).filter(b => text(b, "reason") && (!text(b, "recordedAt") || known(b.recordedAt, cutoff)));
      const hold = unique(blockers.map(b => [text(b, "reason"), text(b, "detail")].filter(Boolean).join(": "))).join("; ");
      const deferred = instant(workflow?.deferredUntil) !== null && Date.parse(text(workflow, "deferredUntil")) > cutoff;
      let status = missing, group = missing, definition = "No verified report status recorded.";
      if (bound) { status = "BOUND"; group = "Bound"; definition = "The CRM records a bound account or policy."; }
      else if (lost) { status = "LOST - REASON NOT RECORDED"; group = "Lost"; definition = "CRM workflow is lost; no competitor outcome is inferred."; }
      else if (text(workflow, "disposition") === "DISQUALIFIED") { status = "DISQUALIFIED"; group = "Unable to work"; definition = "CRM workflow is disqualified; the reason requires review."; }
      else if (hold) { status = "ACTIVE - HOLD"; group = "Active"; definition = "An open CRM task has a recorded blocker."; }
      else if (deferred) { status = "ACTIVE - DEFERRED"; group = "Active"; definition = "CRM workflow is deferred until a recorded future date; a client-requested pause is not inferred."; }
      else if (presented.length) { status = "ACTIVE - QUOTED"; group = "Active"; definition = "Agency quote has been presented to the client."; }
      else if (stalled) { status = "DROPPED OFF"; group = "Dropped off"; definition = "Engaged, then two unanswered personal contacts and seven full days after the second."; }
      else if (tasks.some(t => known(t.dueAt, cutoff))) { status = "ACTIVE - AGENCY ACTION"; group = "Active"; definition = "Agency action is overdue on this lead."; }
      else if (firstOut && !lastReply && inquiry) { status = "NO RESPONSE"; group = "No response"; definition = "No verified reply after the initial inquiry and agency outreach."; }
      else if (text(workflow, "disposition") === "ACTIVE") { status = "ACTIVE"; group = "Active"; definition = "CRM workflow is active; current engagement may be incomplete."; }
      const prior = [...(index.priorCarriers.get(id) ?? [])];
      if (!prior.length && (text(account, "priorCarrierName") || number(account, "priorPremium") !== null)) prior.push({ carrierName: account.priorCarrierName, premium: account.priorPremium, effectiveDate: account.priorTermEffective, expirationDate: account.priorTermExpiration });
      const currentPrior = prior.filter(p => currentTerm(p, asOf));
      const currentPolicies = policies.filter(p => currentTerm(p, asOf));
      const premiumPolicy = bound && currentPolicies.length === 1 ? currentPolicies[0] : undefined;
      const incumbent = currentPrior.length === 1 ? currentPrior[0] : undefined;
      const premiumRecord = bound ? premiumPolicy : quote ?? incumbent;
      const premium = number(premiumRecord, "premium");
      const category = premium === null ? missing : bound ? "Bound Policy" : quote ? "Agency Quote" : "Prior policy; status unverified";
      const lines = quote ? list(quote, "lines") : [];
      const premiumLines = premiumRecord ? unique([...list(premiumRecord, "lines"), text(premiumRecord, "lineOfBusiness")]) : [];
      const premiumName = premiumRecord ? text(premiumRecord, "carrierName") || carriers.get(text(premiumRecord, "carrierId")) || missing : missing;
      const premiumNote = premium === null ? "A single premium with a verified category is not available." : `${category}; ${premiumLines.join("; ") || "coverage basis not recorded"}. No cross-policy total or market average is calculated.`;
      const otherPremiums = [...prior.map(p => ({ p, origin: currentTerm(p, asOf) ? "Prior coverage (term current, status unverified)" : "Prior coverage (term unverified or historical)" })), ...policies.map(p => ({ p, origin: "Agency policy" }))]
        .filter(({ p }) => p !== premiumRecord && number(p, "premium") !== null).map(({ p, origin }) => `${origin}: ${text(p, "carrierName") || carriers.get(text(p, "carrierId")) || "carrier not recorded"}; ${list(p, "lines").join(", ") || text(p, "lineOfBusiness") || "coverage not recorded"}; $${number(p, "premium")!.toFixed(2)}`).join("\n");
      const allCommunication = new Map(contacts.map(c => [text(c.row, "id"), c]));
      const eligibleDocuments = (index.documents.get(id) ?? []).filter(d => text(d, "entityType") === "ACCOUNT" && text(d, "s3Key") && text(d, "s3Key") !== "pending" && !text(d, "quoteId") && !text(d, "policyId") && !["ACORD_FORM", "PF_AGREEMENT", "PF_BOARD_RESOLUTION", "PF_RESOLUTION_EXECUTED"].includes(text(d, "category")));
      const hasReceipt = (d: ReportRecord) => ["lead-upload", "upload-portal"].includes(text(d, "lastWriteBy")) || text(allCommunication.get(text(d, "sourceCommunicationId"))?.row, "direction") === "INBOUND";
      const receivedDocuments = eligibleDocuments.filter(hasReceipt);
      // Staff filing proves availability, not who sent a document or when. Restrict
      // this fallback to clear input categories and completed S3 upload processing.
      // Ambiguous quotes, policies and OTHER files still require receipt evidence.
      const filedDocuments = eligibleDocuments.filter(d => !hasReceipt(d) && !text(d, "sourceCommunicationId")
        && ["PRIOR_POLICY", "CONDO_DOCS", "BUDGET", "DUES_SCHEDULE", "LOSS_RUNS", "STATEMENT_OF_VALUES", "PROPERTY_UPDATES"].includes(text(d, "category"))
        && ["COMPLETE", "SKIPPED", "FAILED"].includes(text(d, "ocrStatus")) && !!text(d, "id")
        && text(d, "s3Key").startsWith(`documents/ACCOUNT/${id}/${text(d, "id")}/`));
      const docDates = receivedDocuments.map(d => allCommunication.get(text(d, "sourceCommunicationId"))?.at ?? known(d.createdAt, cutoff)).filter((v): v is string => !!v).sort((a, b) => Date.parse(a) - Date.parse(b));
      const meaningfulAttachment = (value: unknown) => /\.(pdf|docx?|xlsx?|csv|txt|zip)$/i.test(text(object(value), "filename"));
      const incomingAttachments = inbound.filter(c => Array.isArray(c.row.attachments) && c.row.attachments.some(meaningfulAttachment));
      const docNames = unique([...receivedDocuments.map(d => text(d, "name")), ...filedDocuments.map(d => `${text(d, "name") || "Staff-filed document"} (filed in CRM; receipt date not recorded)`), ...incomingAttachments.flatMap(c => (c.row.attachments as unknown[]).filter(meaningfulAttachment).map(a => text(object(a), "filename")))]);
      const firstDocAt = [...docDates, ...incomingAttachments.map(c => c.at)].sort((a, b) => Date.parse(a) - Date.parse(b))[0];
      const expiration = bound ? (currentPolicies.length === 1 ? text(currentPolicies[0], "expirationDate") : "") : text(account, "currentPolicyExpiration") || (currentPrior.length === 1 ? text(currentPrior[0], "expirationDate") : "");
      const expiryValid = instant(expiration) !== null;
      const expiryConfidence = !expiryValid ? missing : bound ? "Recorded policy term" : currentPrior.some(p => text(p, "expirationDate") === expiration) ? "Recorded incumbent term; not independently verified" : "Reported in CRM; not independently verified";
      const policyBoundDates = policies.filter(p => !text(p, "quoteId") || quotes.some(q => text(q, "id") === text(p, "quoteId"))).map(p => known(p.datePolicyBound, cutoff)).filter((v): v is string => !!v);
      const boundAt = [known(account.convertedAt, cutoff), transition(activities, id, "stage", "CLIENT", cutoff), ...policyBoundDates].filter((v): v is string => !!v).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
      const lostAt = lost ? transition(activities, id, "disposition", "LOST", cutoff, true) : null;
      const lastEmail = communications.filter(c => text(c, "channel") === "EMAIL" && text(c, "direction") === "OUTBOUND" && known(c.at, cutoff) && !c.internalReport && text(c, "purpose") !== "CARRIER" && text(c, "domain") !== "CARRIER" && (text(c, "purpose") === "PROSPECT" || text(c, "domain") === "CLIENT") && !["SERVICE", "RENEWAL"].includes(text(c, "context"))).sort((a, b) => Date.parse(text(a, "at")) - Date.parse(text(b, "at"))).at(-1);
      const emailTracking = !lastEmail ? missing : lastEmail.frontDraft || text(lastEmail, "status") === "DRAFT" ? "Draft only; not sent" : ["FAILED", "REJECTED", "UNDELIVERED"].includes(text(lastEmail, "status")) ? "Delivery failed" : known(lastEmail.seenAt, cutoff) ? text(lastEmail, "actorId").startsWith("crm:") || text(lastEmail, "classification") === "AUTOMATIC" ? "Seen - automated email" : "Seen" : "Read confirmation not recorded";
      const docOutstanding = unique(tasks.filter(t => text(t, "kind") === "DOCUMENTS").map(t => text(t, "title"))).join("; ");
      if (currentPolicies.length > 1 && bound) notes.push("Multiple current bound policies; premium and expiration require policy-level review.");
      if (currentPrior.length > 1) notes.push("Multiple prior policy terms overlap the report date; premiums are listed separately and coverage status is unverified.");
      if (text(account, "notes")) notes.push(`CRM note: ${safeNote(text(account, "notes"))}`);
      const row: ReportCell[] = [
        id || missing, text(account, "name") || missing, text(account, "state") || missing,
        propertyTypeLabel(propertyType), propertyUnits,
        status, group, definition, ...attribution(account), ...coverage(lines), missing,
        unique(prior.map(p => text(p, "carrierName"))).join("; ") || missing,
        dateCell(inquiry), dateCell(firstOut?.at), dateCell(firstReply?.at), dateCell(firstDocAt), dateCell(selected?.at), dateCell(boundAt), dateCell(lostAt),
        dateCell(lastReply?.at), lastReply ? safeNote(text(lastReply.row, "summary") || text(lastReply.row, "subject")) || "Verified human client reply" : missing,
        dateCell(lastOut?.at), emailTracking,
        docNames.length ? "Y" : missing, safeNote(docNames.join("; "), 400) || missing, safeNote(docOutstanding, 400) || missing, presented.length ? "Y" : missing,
        quote ? carriers.get(text(quote, "carrierId")) || missing : missing, number(quote, "premium"), premium, category,
        category === "Agency Quote" || category === "Bound Policy" ? "N" : missing, premium === null ? missing : [premiumName, ...premiumLines].join("; "), premiumNote, safeNote(otherPremiums, 400) || missing,
        expiryValid ? dateCell(expiration) : null, expiryConfidence, hold || (deferred ? `Deferred until ${text(workflow, "deferredUntil")}` : missing),
        quotes.length || bound ? "Y" : missing, missing, missing, days(inquiry, asOf), days(inquiry, lastReply?.at), days(lastReply?.at, asOf), days(lastOut?.at, asOf),
        missing, notes.join("\n") || missing,
      ];
      return row;
    });
  return { headers: MARKETING_REPORT_HEADERS, rows, asOf, warnings };
}
