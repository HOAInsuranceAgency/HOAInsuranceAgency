import { cleanAttribution, websiteLeadSource } from "../../../../shared/leadSource";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Schema } from "../../data/resource";
import { DEFAULT_ACCOUNT_TYPE, DEFAULT_CONTACT_TYPE, isAccountType } from "../../../src/lib/enums";
import { contactKey, priorCarrierKey } from "../../../src/lib/extractionKeys";
import { NO_UPLOAD_WINDOW_MINUTES } from "../../../../shared/leadUpload";
import { parsePolicyExpiration, parseUnitCount } from "./fields";
import { canonical, hash, get, row, put, commit, conflict, type Write } from "../communications/store";
import { defaultWorkflow } from "../communications/workflow";

export interface Submission {
  fingerprint: string; proofHash: string; accountId: string; uploadToken: string | null;
  snapshot: Record<string, unknown>; receivedAt: string;
}
const clean = (v: unknown, max = 500): string | undefined => typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
export function replay(existing: Submission, fingerprint: string, proof: string) {
  const supplied = Buffer.from(hash(proof)), expected = Buffer.from(existing.proofHash);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected) || existing.fingerprint !== fingerprint) {
    return { ok: false, error: "This submission could not be verified. Keep your answers and try again." };
  }
  return { ok: true, duplicate: true, id: existing.accountId, uploadToken: existing.uploadToken, uploadWindowMinutes: existing.uploadToken ? NO_UPLOAD_WINDOW_MINUTES : null };
}
export function modelPut(name: string, id: string, fields: Record<string, unknown>): Write {
  const tableName = process.env[`${name.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}_TABLE`];
  if (!tableName) throw new Error("Lead storage needs configuration");
  const at = new Date().toISOString();
  return { Put: { TableName: tableName, Item: { id, __typename: name, createdAt: at, updatedAt: at, ...fields }, ConditionExpression: "attribute_not_exists(id)" } };
}
export const handler: Schema["submitWebLead"]["functionHandler"] = async event => {
  // Amplify's generated resolver supplies arguments, but no event.info.
  if ("readinessContract" in event.arguments) {
    const contractVersion = Number(event.arguments.readinessContract);
    if (![1, 2].includes(contractVersion)) return { ready: false, contractVersion: 2 };
    if (!["COMMUNICATION_TABLE", "ACCOUNT_TABLE", "CONTACT_TABLE", "PRIOR_CARRIER_TABLE", "LEAD_REPLY_TABLE", "USER_POOL_ID"].every(key => process.env[key])) return { ready: false, contractVersion };
    try { await get("config"); return { ready: true, contractVersion }; }
    catch { return { ready: false, contractVersion }; }
  }
  const args = event.arguments;
  const legacy = args.submissionId == null && args.retryProof == null;
  const submissionId = legacy ? randomUUID() : clean(args.submissionId, 100), proof = legacy ? randomBytes(32).toString("hex") : clean(args.retryProof, 200);
  if (!submissionId || !/^[a-zA-Z0-9-]{20,100}$/.test(submissionId) || !proof || !/^[a-zA-Z0-9_-]{40,200}$/.test(proof)) return { ok: false, error: "Please refresh this form before submitting." };
  const { submissionId: _id, retryProof: _proof, ...answers } = args;
  if (Buffer.byteLength(JSON.stringify(answers)) > 60_000) return { ok: false, error: "Please shorten the enquiry and try again." };
  const fingerprint = hash(canonical(answers)), key = `submission:${submissionId}`;
  const previous = await get<Submission>(key);
  if (previous) return replay(previous.data, fingerprint, proof);
  const name = clean(args.name, 200);
  if (!name) return { ok: false, error: "Name is required" };
  const id = randomUUID(), at = new Date().toISOString();
  const email = clean(args.contactEmail, 320);
  const validEmail = email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined;
  const unitCount = parseUnitCount(args.unitCount), expiration = parsePolicyExpiration(args.currentPolicyExpiration);
  const contactName = [clean(args.contactFirstName, 100), clean(args.contactLastName, 100)].filter(Boolean).join(" ") || name;
  const notes = [clean(args.notes, 10000), args.unitNumber && `Unit: ${clean(args.unitNumber)}`, email && !validEmail && `Email (unvalidated): ${email}`,
    unitCount === null && args.unitCount && `Units (unparsed): ${clean(args.unitCount)}`,
    expiration === null && args.currentPolicyExpiration && `Program expiry (unparsed): ${clean(args.currentPolicyExpiration)}`].filter(Boolean).join("\n");
  const workflow = await defaultWorkflow(id, name);
  const attribution = cleanAttribution(args.attribution);
  const account = { leadSource: websiteLeadSource(attribution), leadAttribution: JSON.stringify(attribution), stage: "LEAD", type: isAccountType(args.type) ? args.type : DEFAULT_ACCOUNT_TYPE, name,
    address: clean(args.address, 500), city: clean(args.city, 100), state: clean(args.state, 2)?.toUpperCase(), zip: clean(args.zip, 10),
    unitCount: unitCount ?? undefined, currentPolicyExpiration: expiration ?? undefined, buildiumId: clean(args.buildiumId, 50), source: clean(args.source, 100) ?? "website", notes, lastWriteBy: "lead-intake" };
  const token = validEmail ? randomBytes(32).toString("base64url") : null;
  let snapshot: Record<string, unknown> = { ...answers };
  if (typeof args.answerSnapshot === "string") { try { snapshot = { ...answers, answers: JSON.parse(args.answerSnapshot) }; } catch { return { ok: false, error: "The form answers could not be read." }; } }
  snapshot.leadSource = account.leadSource;
  const submission: Submission = { fingerprint, proofHash: hash(proof), accountId: id, uploadToken: token, snapshot, receivedAt: at };
  const writes: Write[] = [put(row("SUBMISSION", key, submission)), modelPut("Account", id, account),
    put(row("WORKFLOW", `workflow:${id}`, workflow, { accountId: id })),
    put(row("OPERATION", `op:intake:${submissionId}`, { type: "IMPORT", state: "READY", submissionId, accountId: id, attempts: 0 }, { accountId: id, dueAt: at })),
    put(row("OPERATION", `op:sms-alert:${submissionId}`, { type: "SMS_ALERT", state: "READY", accountId: id, attempts: 0,
      lead: { id, name, city: account.city, state: account.state, contactName, contactPhone: clean(args.contactPhone, 50), source: account.source } }, { accountId: id, dueAt: at })),
  ];
  if (contactName || validEmail || args.contactPhone) {
    const person = { name: contactName, email: validEmail, phone: clean(args.contactPhone, 50), type: DEFAULT_CONTACT_TYPE };
    writes.push(modelPut("Contact", randomUUID(), { accountId: id, ...person, isPrimary: true, lastWriteBy: "lead-intake", extractionSourceKey: contactKey(person) }));
  }
  const carrierName = clean(args.currentCarrier, 200);
  if (carrierName) writes.push(modelPut("PriorCarrier", randomUUID(), { accountId: id, carrierName, expirationDate: expiration ?? undefined, lastWriteBy: "lead-intake", extractionSourceKey: priorCarrierKey({ carrierName, policyNumber: null, lineOfBusiness: null }) }));
  if (validEmail && token) writes.push(modelPut("LeadReply", `reply:${submissionId}`, { accountId: id, submissionId, contactEmail: validEmail, contactName, status: "WAITING", uploadToken: token,
    submittedAt: at, dueAt: new Date(Date.now() + NO_UPLOAD_WINDOW_MINUTES * 60_000).toISOString(), uploadCount: 0 }));
  if (workflow.assignmentIssue || !validEmail) writes.push(put(row("ISSUE", `issue:intake:${id}`, { message: workflow.assignmentIssue ?? "Correct the prospect email before sending", at }, { accountId: id })));
  try { await commit(writes); }
  catch (e) {
    if (conflict(e)) { const winner = await get<Submission>(key); if (winner) return replay(winner.data, fingerprint, proof); }
    console.error("Durable lead capture failed", e instanceof Error ? e.name : "unknown");
    return { ok: false, error: "We couldn't save your request. Your answers are still here; please try again." };
  }
  return { ok: true, id, uploadToken: token, uploadWindowMinutes: token ? NO_UPLOAD_WINDOW_MINUTES : null };
};
