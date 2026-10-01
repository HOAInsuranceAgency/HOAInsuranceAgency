/** Fictional in-memory data only: no CRM API, provider request, or messaging. */
import type { Communication, LeadWorkflow, TeamEligibility, WorkflowContext } from '../../../shared/leadWorkflow';
import type { Activity } from '../../src/lib/client';
export type { Activity, Account, Policy } from '../../src/lib/client';
export type { Communication, LeadWorkflow, TeamEligibility, WorkflowContext } from '../../../shared/leadWorkflow';
export { listAllPages } from '../../src/lib/pagination';

export const scenario = new URLSearchParams(location.search).get('scenario') || 'lead';
export const isClient = scenario === 'client';
const time = (hoursAgo = 0) => new Date(Date.now() - hoursAgo * 3600000).toISOString();
export const account = { id: 'fictional-willow', name: 'Willow Court Condominium', stage: isClient ? 'CLIENT' : 'LEAD', type: 'ASSOCIATION', city: 'Boston', state: 'MA', createdAt: time(24 * 14), convertedAt: isClient ? time(24 * 4) : undefined };
const actorId = '11111111-2222-4333-8444-555555555555';
const formerId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
export const team: TeamEligibility[] = [
  { userId: actorId, name: 'Avery Brooks', email: 'avery@example.test', frontId: 'tea_avery', dialpadId: 'dial_avery', enabled: true, salesperson: true, available: true },
  { userId: 'jordan', name: 'Jordan Ellis', email: 'jordan@example.test', frontId: 'tea_jordan', enabled: true, salesperson: true, available: true },
  { userId: formerId, name: 'Morgan Lane', email: 'morgan@example.test', frontId: 'tea_morgan', enabled: false, salesperson: true, available: false },
];
const workflow: LeadWorkflow = { accountId: account.id, name: account.name, salespersonId: actorId, disposition: isClient ? 'BOUND' : 'ACTIVE', conversationId: 'cnv_fictional_willow', version: 1, updatedAt: time(), humanTakeover: isClient, ...(scenario === 'lead' ? { assignmentIssue: 'The linked Front conversation is assigned to Jordan Ellis. Review the handler before replying.' } : {}) };
const comm = (id: string, channel: Communication['channel'], direction: Communication['direction'], hoursAgo: number, extra: Partial<Communication>): Communication => ({ id, accountId: account.id, conversationId: workflow.conversationId, channel, direction, at: time(hoursAgo), provider: channel === 'CALL' || channel === 'SMS' ? 'dialpad' : channel === 'NOTE' ? 'crm' : 'front', providerId: `fictional-${id}`, status: direction === 'INBOUND' ? 'RECEIVED' : 'SENT', classification: 'SUBSTANTIVE', version: 1, ...extra });
const communications: Communication[] = scenario === 'empty' ? [] : [
  comm('email-inbound', 'EMAIL', 'INBOUND', 1, { subject: 'Updated building schedule and renewal questions', from: 'alex.propertymanager@example.test', to: ['avery@example.test'], text: 'Hi Avery,\n\nThe board approved the updated building schedule. Can you confirm the replacement cost and deductible before Friday’s meeting?\n\nThe attached file includes the roof work for Building 4 and the new common-area electrical panels.\n\nThanks,\nAlex', attachments: [{ id: 'attachment-1', filename: 'Willow_Court_Condominium_Association_2026_Updated_Building_Schedule_Replacement_Cost_and_Roof_Improvements_FINAL_REVISED.pdf', content_type: 'application/pdf', size: 2450000 }] }),
  comm('call', 'CALL', 'OUTBOUND', 3, { from: '+16175550123', to: ['+16175550142'], actorId, status: 'CONNECTED', endedAt: time(2.85), summary: 'Discussed the updated schedule and agreed to send two coverage options.', text: 'Alex prefers a bundled property and liability option. The board will compare premiums at its next meeting.', enrichment: '8-minute call · Dialpad summary available' }),
  comm('sms', 'SMS', 'INBOUND', 5, { from: '+16175550142', to: ['+16175550123'], text: 'I sent the updated roof documents. The board is available Friday at 2:30 if you can call then.' }),
  comm('note', 'NOTE', 'INTERNAL', 7, { actorId: 'jordan', status: 'RECORDED', subject: 'Board prefers a $5,000 deductible', text: 'Discussed the renewal with the property manager. Confirm the umbrella limit before finalizing the presentation. Please preserve the existing D&O retroactive date.' }),
  comm('email-outbound', 'EMAIL', 'OUTBOUND', 22, { from: 'avery@example.test', to: ['alex.propertymanager@example.test'], actorId: 'tea_avery', subject: 'Willow Court — coverage comparison', text: 'Hi Alex,\n\nI’m preparing the property and general liability comparison. Please send the latest board roster and loss runs when available.\n\nAvery', seenAt: time(20), seenCheckedAt: time(19) }),
  comm('missed-call', 'CALL', 'INBOUND', 25, { from: '+16175550142', to: ['+16175550123'], status: 'MISSED', text: 'Caller requested a callback about the renewal.', enrichment: 'Voicemail received' }),
];
const context: WorkflowContext = {
  workflow, communications, team, tasks: [], actorId, trackingHealthy: scenario !== 'lead',
  frontContext: { conversationId: workflow.conversationId!, assigneeId: scenario === 'lead' ? 'tea_jordan' : 'tea_avery', routing: scenario === 'lead' ? 'MANUAL' : 'SALESPERSON', purpose: 'PROSPECT', context: isClient ? 'SERVICE' : 'LEAD' },
  issues: scenario === 'lead' ? [
    { id: 'tracking', message: 'A recent call has not been matched to this account. Review its source before linking it.', at: time(2) },
    { id: 'attachment', message: 'The latest building schedule could not be saved to CRM documents. Retry from the email below.', at: time(1) },
  ] : [],
};

const change = (field: string, from: unknown, to: unknown) => ({ field, from, to });
const audit = (index: number, subjectType: string, subjectLabel: string, summary: string, changes: ReturnType<typeof change>[], extra: Record<string, unknown> = {}) => ({
  id: `fictional-audit-${index}`, entityId: account.id, entityType: 'Account', occurredAt: time(index * 5 + 1),
  actor: index % 4 === 0 ? null : index % 3 === 0 ? formerId : actorId,
  actorName: index % 4 === 0 ? 'System' : index % 3 === 0 ? 'Morgan Lane' : index % 2 === 0 ? 'Unknown user' : 'Avery Brooks',
  subjectType, subjectId: `fictional-subject-${index}-3e48eb81-5e30-4b1d-a0a2-8476d867babc`, subjectLabel,
  action: index % 5 === 0 ? 'CREATE' : index === 13 ? 'DELETE' : 'UPDATE', summary,
  changes: JSON.stringify(changes), ...extra,
}) as unknown as Activity;
const longFile = 'Willow_Court_Condominium_Association_2026_Property_Application_With_Roof_Updates_Building_Schedule_And_Replacement_Cost_Appendix_FINAL.pdf';
const activities: Activity[] = scenario === 'empty' ? [] : [
  audit(1, 'Account', account.name, 'Updated the building values, roof information, and renewal notes.', [change('totalInsuredValue', 4200000, 4850000), change('unitCount', 24, 28), change('roofYear', 2008, 2025), change('notes', 'Renewal review requested.', 'Board approved the new roof replacement and electrical upgrades. Include all four buildings and the detached maintenance garage in the revised coverage comparison.')]),
  audit(2, 'Document', longFile, 'Renamed the application and linked it to the current quote.', [change('name', 'Application.pdf', longFile), change('quoteId', null, '4d8a5b16-7c40-4efb-8a3e-122398847acd'), change('status', 'UPLOADED', 'REVIEWED'), change('notes', '', 'Updated roof schedule verified against the board-approved property inventory.')]),
  audit(3, 'Quote', 'Harbor Mutual · Commercial Property + General Liability', 'Updated premium, deductible, coverage limit, and effective date.', [change('premium', 18250, 17400), change('perOccurrenceDeductible', 10000, 5000), change('blanketLimit', 4200000, 4850000), change('effectiveDate', '2026-10-01', '2026-11-01')]),
  audit(4, 'Communication', '4f9d6c80-4d02-4d87-b7cc-61fd2f820b05', 'Linked an inbound email to the account.', [change('accountId', null, account.id), change('conversationId', null, 'cnv_fictional_willow_very_long_source_identifier_for_review'), change('status', 'UNMATCHED', 'RECEIVED')]),
  audit(5, 'Contact', 'Alex Taylor', 'Added a property-manager contact.', [change('name', null, 'Alex Taylor'), change('email', null, 'alex.propertymanager@example.test'), change('phone', null, '+16175550142'), change('isPrimary', null, true)]),
  audit(6, 'PropertyBuilding', 'Building 4 · Maintenance and recreation facilities', 'Updated construction and fire protection details.', [change('constructionType', 'Frame', 'Joisted masonry'), change('squareFeet', 4200, 4800), change('sprinklered', false, true)]),
  audit(7, 'Quote', 'Summit Specialty · Directors & Officers', 'Changed the quote status from QUOTED to PRESENTED.', [change('status', 'QUOTED', 'PRESENTED')]),
  audit(8, 'Document', 'Five-Year-Loss-Runs_2021-2026_Willow-Court-Association.pdf', 'Completed document extraction.', [change('extractionStatus', 'PROCESSING', 'COMPLETE'), change('pageCount', null, 24), change('notes', '', 'Five-year loss history and current valuation included.'), change('coverageDetails', { property: { limit: 4200000 }, buildings: ['A', 'B', 'C'] }, { property: { limit: 4850000, deductible: 5000 }, buildings: ['A', 'B', 'C', 'D'], description: 'Includes the detached maintenance garage and common-area electrical panels.' })]),
  audit(9, 'Account', account.name, 'Changed the current policy expiration.', [change('currentPolicyExpiration', '2026-10-01', '2026-11-01')]),
  audit(10, 'Invoice', 'PREVIEW-1042', 'Created a draft invoice.', [change('number', null, 'PREVIEW-1042'), change('amount', null, 17400), change('status', null, 'DRAFT'), change('memo', null, 'Fictional preview invoice; no payment is due.')]),
  audit(11, 'Contact', 'Riley Chen', 'Updated board contact details.', [change('title', 'Treasurer', 'Board president'), change('phone', '+16175550166', '+16175550177'), change('email', 'riley@example.test', 'riley.board@example.test')]),
  audit(12, 'Communication', 'Inbound call', 'Recorded a missed call.', [change('status', null, 'MISSED'), change('direction', null, 'INBOUND'), change('from', null, '+16175550142')]),
  audit(13, 'Document', 'Outdated application — duplicate upload.pdf', 'Deleted a duplicate document.', [change('name', 'Outdated application — duplicate upload.pdf', null)], { actor: null, actorName: 'System' }),
  audit(14, 'Account', account.name, 'Updated the mailing address and management company.', [change('address', '100 Example St', '100 Example Street, Buildings A–D and detached maintenance garage'), change('city', 'Boston', 'Boston'), change('managementCompany', 'Previous Property Management', 'Example Community Management and Association Services')]),
];

export const fmtDateTime = (value?: string | null) => value ? new Date(value).toLocaleString('en-US') : '—';
export const fmtDate = (value?: string | null) => value ? new Date(`${value.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US') : '—';
export const fmtMoney = (value?: number | null) => value == null ? '—' : value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
export const fmtProviderPhone = (value?: string | null) => value?.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3') || '—';
export const friendlyError = (error: unknown, fallback = 'Please try again.') => error instanceof Error && error.message ? error.message : fallback;
async function ready() {
  if (scenario === 'loading') await new Promise<void>(() => {});
  if (scenario === 'error') throw new Error('Preview: account activity could not be loaded.');
}
export const client = { models: {
  Activity: { async listActivityByEntityIdAndOccurredAt(_input: unknown, options?: { nextToken?: string }) { await ready(); const start = options?.nextToken ? Number(options.nextToken) : 0; return { data: structuredClone(activities.slice(start, start + 10)), nextToken: start + 10 < activities.length ? String(start + 10) : null }; } },
  UserProfile: { async listUserProfileByUserId({ userId }: { userId: string }) { return { data: userId === actorId ? [{ id: 'profile-avery', firstName: 'Avery', lastName: 'Brooks', email: 'avery@example.test' }] : [] }; } },
  Policy: { async list() { return { data: isClient ? [{ id: 'fictional-policy', policyNumber: 'PREVIEW-P1001', lines: ['Commercial Property', 'General Liability'], expirationDate: '2027-10-01' }] : [] }; } },
  Account: { async list() { return { data: [structuredClone(account)] }; } },
} };
export async function communicationRequest<T>(operation: string, input: unknown = {}, _write = false): Promise<T> {
  await ready();
  const data = input as Record<string, unknown>;
  if (operation === 'context') return structuredClone(context) as T;
  if (operation === 'team') return { team: structuredClone(team) } as T;
  if (operation === 'work') return { items: [] } as T;
  if (operation === 'setResponsibilities') { workflow.salespersonId = String(data.salespersonId); workflow.assignmentIssue = undefined; }
  else if (operation === 'setLeadDisposition') workflow.disposition = data.disposition as LeadWorkflow['disposition'];
  else if (operation === 'cancelAi') workflow.humanTakeover = true;
  else if (operation === 'routeConversation') Object.assign(context.frontContext!, { routing: 'SALESPERSON', assigneeId: team.find(person => person.userId === workflow.salespersonId)?.frontId });
  else if (operation === 'linkConversation') Object.assign(context.frontContext!, { purpose: data.purpose, context: data.context, policyId: data.policyId });
  else if (operation === 'addNote') communications.unshift(comm(`note-${crypto.randomUUID()}`, 'NOTE', 'INTERNAL', 0, { actorId, status: 'RECORDED', text: String(data.text) }));
  else if (operation === 'refreshSeen') { const row = communications.find(item => item.id === data.id); if (row) row.seenCheckedAt = time(); }
  else if (operation === 'saveAttachment') context.issues = context.issues.filter(issue => issue.id !== 'attachment');
  else throw new Error('This preview cannot run that operation.');
  workflow.version++; workflow.updatedAt = time();
  return { notice: 'Preview updated locally. No messages sent or real records changed.' } as T;
}
