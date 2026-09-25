import { communicationRequest as commercial, accounts } from '../commercial-preview/fixtures';
import { communicationRequest as workflow } from '../front-sidebar-preview/fixtures';
export type { TeamEligibility, WorkflowContext, LeadTask, Communication } from '../../../shared/leadWorkflow';
export const tasks = accounts.map((a, i) => ({ id: `task-${a.id}`, accountId: a.id, name: a.name, title: ['Review prospect reply', 'Call the property manager', 'Confirm the remaining D&O quote'][i], kind: ['REPLY', 'FOLLOW_UP', 'QUOTE_TO_BIND'][i], dueAt: '2026-09-24T13:00:00Z', status: 'OPEN', role: 'SALESPERSON', version: 1 }));
export async function communicationRequest<T>(op: string, input: Record<string, any> = {}, write = false): Promise<T> {
  if (write) throw new Error('Preview only: mutations are disabled.');
  if (op === 'commercialTable') { const r = await commercial<any>(op, input); return { ...r, items: r.items.map((item: any) => ({ ...item, nextAction: tasks.find(t => t.accountId === item.accountId), actionCount: 1 })) }; }
  if (['team', 'lastContacts'].includes(op)) return commercial(op, input);
  if (op === 'work') return { items: input.kind === 'TASK' ? tasks : [] } as T;
  return workflow(op, input);
}
