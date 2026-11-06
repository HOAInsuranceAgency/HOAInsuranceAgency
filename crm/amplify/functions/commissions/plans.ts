import { randomUUID } from 'node:crypto';
import { day, required, validatePlan, validatePlanDefinition, type CommissionPlan, type CommissionPlanDefinition } from '../../../../shared/commissions';
import { AccountAccess } from '../crm-access/access';
import { object } from '../crm-access/policy';
import type { Event } from './handler';
import { change, condition } from './payroll';
import * as store from './store';

export const planOperations = new Set(['saveCommissionPlan', 'savePlanAssignments']);
export async function planAction(event: Event, actor: string, operation: string, input: store.Data) {
  if (operation === 'saveCommissionPlan') {
    const id = input.id ? required(input.id, 'a plan ID', 128) : randomUUID();
    const old = await store.get<CommissionPlanDefinition>('PLAN_DEFINITION', id);
    if (input.version !== (old?.version ?? 0)) throw new Error('This commission plan changed. Refresh before saving.');
    const plan = validatePlanDefinition({ ...input, id } as unknown as CommissionPlanDefinition);
    await store.commit([change('PLAN_DEFINITION', plan, old)], actor);
    return { ok: true, id };
  }
  const producerId = required(input.producerId, 'a producer', 128);
  const profile = await new AccountAccess(event.identity, undefined, event.request).get('Communication', `eligibility:${producerId}`);
  if (!profile || object(profile.data).userId !== producerId) throw new Error('Choose a teammate from the team roster.');
  const old = await store.get<CommissionPlan>('PLAN', producerId);
  if (input.version !== (old?.version ?? 0)) throw new Error('Producer assignments changed. Refresh before saving.');
  if (!Array.isArray(input.assignments) || !input.assignments.length || input.assignments.length > 100) throw new Error('Enter 1-100 dated assignments. End an assignment to leave a producer unassigned.');
  const guards = new Map<string, CommissionPlanDefinition>();
  const terms: CommissionPlan['terms'] = [];
  const ids = new Set<string>();
  for (const row of input.assignments as store.Data[]) {
    const id = required(row.id, 'an assignment ID', 128);
    if (ids.has(id)) throw new Error('Each assignment must appear only once.');
    ids.add(id);
    const previous = old?.terms.find((t, index) => (t.assignment?.id ?? `legacy:${index}`) === id);
    let rates: Pick<CommissionPlan['terms'][number], 'newBps' | 'renewalBps' | 'gim' | 'assignment'>;
    if (!row.planId) {
      if (!previous || previous.assignment) throw new Error('Select a reusable commission plan.');
      // Keep pre-feature rates unchanged while allowing a dated transition.
      rates = { newBps: previous.newBps, renewalBps: previous.renewalBps, ...(previous.gim ? { gim: previous.gim } : {}) };
    } else if (previous?.assignment?.planId === row.planId && previous.assignment.planVersion === row.planVersion) {
      rates = { newBps: previous.newBps, renewalBps: previous.renewalBps, ...(previous.gim ? { gim: previous.gim } : {}), assignment: previous.assignment };
    } else {
      const definition = await store.get<CommissionPlanDefinition>('PLAN_DEFINITION', required(row.planId, 'a plan', 128));
      if (!definition || definition.archived) throw new Error('Select an available commission plan.');
      if (row.planVersion !== definition.version) throw new Error('The selected plan changed. Refresh and review its rates.');
      guards.set(definition.id, definition);
      rates = { newBps: definition.newBps, renewalBps: definition.renewalBps, ...(definition.gim ? { gim: definition.gim } : {}), assignment: { id, planId: definition.id, planVersion: definition.version, planName: definition.name, planReference: definition.agreement } };
    }
    const agreement = required(row.agreement, 'the employee agreement reference');
    terms.push({ ...rates, from: day(row.from), ...(row.to ? { to: day(row.to) } : {}), agreement,
      ...(rates.gim ? { gim: { ...rates.gim, agreement: rates.assignment ? agreement : rates.gim.agreement } } : {}),
      ...(row.accountBoundFrom ? { accountBoundFrom: day(row.accountBoundFrom) } : {}),
      ...(row.receiptsFrom ? { receiptsFrom: day(row.receiptsFrom) } : {}),
      ...(rates.assignment ? { assignment: { ...rates.assignment, notes: row.notes ? required(row.notes, 'assignment notes', 2000) : undefined } } : {}),
    });
  }
  const plan = validatePlan({ id: producerId, version: old?.version ?? 0, producerId, name: required(object(profile.data).name ?? input.name, 'the producer name', 200), terms });
  await store.commit([change('PLAN', plan, old)], actor, [...guards.values()].map(d => condition('PLAN_DEFINITION', d)));
  return { ok: true };
}
