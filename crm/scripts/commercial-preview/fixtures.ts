import { packageAssessment, parseEstimate } from '../../../shared/quotePackages';
import { createCommercialScenario, reviewedCommercialOption } from '../../fixtures/commercial';
export * from '../../fixtures/presentation';
export const { accounts, quotes, carriers, contacts, policies, plans, team } = createCommercialScenario();
const option = (id: string, quoteIds: string[]) => reviewedCommercialOption(id, quoteIds, quotes);
export const client = { models: {
  Account: { async list(input?: { filter?: { stage?: { eq: string } } }) {
    return { data: structuredClone(accounts.filter(row => !input?.filter?.stage?.eq || row.stage === input.filter.stage.eq)) };
  } },
  Quote: { async list() { return { data: structuredClone(quotes) }; } },
  Contact: { async list() { return { data: structuredClone(contacts) }; } },
  Policy: { async list() { return { data: structuredClone(policies) }; } },
} };
export async function communicationRequest<T>(
  op: string,
  input: Record<string, unknown> = {},
): Promise<T> {
  if (op === 'team') return { team } as T;
  if (op === 'lastContacts')
    return {
      items: (input.accounts as { accountId: string }[]).map((a) => ({
        accountId: a.accountId,
        contact: {
          at: '2026-09-14T13:00:00Z',
          channel: 'EMAIL',
          direction: 'OUTBOUND',
        },
        complete: true,
      })),
    } as T;
  if (op === 'commercialTable')
    return {
      items: (input.accountIds as string[]).map((id) => ({
        accountId: id,
        plan: structuredClone(plans[id]),
        salespersonId: 'sales',
        championId: 'champ',
      })),
    } as T;
  if (op === 'saveCommercial') {
    const p = plans[String(input.accountId)];
    if (p.version !== input.version)
      throw new Error('Refresh this preview before saving');
    if (input.action === 'ESTIMATE')
      p.estimatedCents = parseEstimate(input.amount);
    else if (input.action === 'SELECT') {
      const o = p.options.find((o) => o.id === input.optionId)!;
      p.selectedOptionId = o.id;
      p.selectedTerms = { ...o.reviewed!.terms };
    } else if (input.action === 'CLEAR_SELECTION') {
      p.selectedOptionId = null;
      p.selectedTerms = undefined;
    } else if (input.action === 'REMOVE_OPTION')
      p.options = p.options.filter((o) => o.id !== input.optionId);
    else if (input.action === 'SAVE_OPTION') {
      const o = {
        id: String(input.optionId || `preview-${p.version}`),
        name: String(input.name),
        quoteIds: input.quoteIds as string[],
        reviewed: undefined as
          ReturnType<typeof option>['reviewed'] | undefined,
      };
      p.requiredLines = input.requiredLines as string[];
      if (input.reviewed) {
        const a = packageAssessment(p, o, quotes, '2026-09-14', false);
        if (!a.complete) throw new Error(a.problems.join('. '));
        o.reviewed = option(o.id, o.quoteIds).reviewed;
      }
      p.options = [...p.options.filter((old) => old.id !== o.id), o];
    }
    p.version++;
    return { plan: structuredClone(p) } as T;
  }
  throw new Error('This preview cannot run that operation');
}
