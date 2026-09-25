import { randomUUID } from 'node:crypto';
import {
  emptyCommercialPlan,
  packageAssessment,
  packageTerms,
  parseEstimate,
  type CommercialPlan,
  type PackageOption,
} from '../../../../shared/quotePackages';
import { agencyDay } from '../../../../shared/leadActionGuidance';
import { dataClient } from './data';
import {
  audit,
  check,
  absent,
  commit,
  get,
  put,
  row,
  type Write,
} from './store';
import type { LeadWorkflow, LeadTask } from '../../../../shared/leadWorkflow';
import type { Schema } from '../../data/resource';

const idOf = (id: unknown) => {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id))
    throw new Error('Choose a valid account');
  return id;
};
export async function commercialTable(ids: unknown, includeActions = false) {
  if (
    !Array.isArray(ids) ||
    ids.length > 25 ||
    new Set(ids).size !== ids.length
  )
    throw new Error('Choose up to 25 accounts');
  return Promise.all(
    ids.map(async (raw) => {
      const id = idOf(raw),
        [plan, workflow] = await Promise.all([
          get<CommercialPlan>(`commercial:${id}`),
          get<LeadWorkflow>(`workflow:${id}`),
        ]);
      const tasks = includeActions ? await (await import('./workflow')).accountRows<LeadTask>(id, 'TASK') : [];
      const open = tasks.map(task => ({ ...task.data, version: task.version })).filter(task => task.status === 'OPEN').sort((a,b) => (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999"));
      return {
        ...(includeActions ? { nextAction: open[0] ?? null, actionCount: open.length } : {}),
        accountId: id,
        plan: plan
          ? { ...plan.data, version: plan.version }
          : emptyCommercialPlan(id),
        salespersonId: workflow?.data.salespersonId,
        championId: workflow?.data.championId,
      };
    }),
  );
}
export async function saveCommercial(
  input: Record<string, unknown>,
  actor: string,
) {
  const accountId = idOf(input.accountId),
    old = await get<CommercialPlan>(`commercial:${accountId}`);
  if (!Number.isInteger(input.version) || input.version !== (old?.version ?? 0))
    throw new Error('This account changed. Refresh before saving.');
  const account = await (
    await dataClient()
  ).models.Account.get({ id: accountId });
  if (account.errors?.length || !account.data)
    throw new Error('Could not load this account');
  if (await get(`deleted-account:${accountId}`))
    throw new Error('This account is being deleted');
  let plan: CommercialPlan = old
    ? { ...old.data }
    : emptyCommercialPlan(accountId);
  const writes: Write[] = [];
  const previouslySelected = plan.options.find(
    (o) => o.id === plan.selectedOptionId,
  );
  const guardedQuoteIds = previouslySelected?.quoteIds ?? [];
  if (input.action === 'ESTIMATE')
    plan.estimatedCents = parseEstimate(input.amount);
  else {
    const quotes: Schema['Quote']['type'][] = [];
    let token: string | null | undefined;
    do {
      const page = await account.data.quotes({ nextToken: token, limit: 100 });
      if (page.errors?.length) throw new Error('Could not load quotes');
      quotes.push(...page.data);
      token = page.nextToken;
    } while (token);
    if (input.action === 'SAVE_OPTION') {
      if (
        !Array.isArray(input.requiredLines) ||
        input.requiredLines.length > 30 ||
        !input.requiredLines.every(
          (l) => typeof l === 'string' && l.trim() && l.length < 100,
        )
      )
        throw new Error('Choose the coverages needed');
      if (
        !Array.isArray(input.quoteIds) ||
        !input.quoteIds.length ||
        input.quoteIds.length > 25 ||
        !input.quoteIds.every((id) => typeof id === 'string') ||
        new Set(input.quoteIds).size !== input.quoteIds.length
      )
        throw new Error('Choose up to 25 different quotes');
      const quoteIds = input.quoteIds as string[];
      if (
        quoteIds.some(
          (id) => !quotes.some((q) => q.id === id && q.accountId === accountId),
        )
      )
        throw new Error('Choose quotes from this account');
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (!name || name.length > 100)
        throw new Error('Name this package option');
      const previous = plan.options.find((o) => o.id === input.optionId);
      if (input.optionId && !previous)
        throw new Error('Refresh this package option');
      if (plan.selectedOptionId && previous?.id !== plan.selectedOptionId)
        throw new Error(
          'Edit the selected package, or clear the client selection first',
        );
      if (
        previous?.id === plan.selectedOptionId &&
        previous.quoteIds.some((id) => {
          const q = quotes.find((q) => q.id === id);
          return (
            q &&
            (q.status === 'BOUND' || q.bindAuthorizedAt) &&
            !quoteIds.includes(id)
          );
        })
      )
        throw new Error(
          'Keep bound and authorized policies in the selected package',
        );
      if (!previous && plan.options.length >= 20)
        throw new Error('Remove an unused package option first');
      const requiredLines = [
        ...new Set((input.requiredLines as string[]).map((l) => l.trim())),
      ];
      const scopeChanged =
        JSON.stringify(requiredLines.slice().sort()) !==
        JSON.stringify(plan.requiredLines.slice().sort());
      if (scopeChanged)
        plan.options = plan.options.map((o) => ({ ...o, reviewed: undefined }));
      if (
        previous?.id === plan.selectedOptionId &&
        (scopeChanged ||
          JSON.stringify(quoteIds.slice().sort()) !==
            JSON.stringify(previous.quoteIds.slice().sort()))
      )
        plan.selectedTerms = undefined;
      plan.requiredLines = requiredLines;
      const option: PackageOption = {
        id: previous?.id ?? randomUUID(),
        name,
        quoteIds,
      };
      if (input.reviewed === true) {
        const assessment = packageAssessment(
          plan,
          option,
          quotes,
          agencyDay(new Date().toISOString()),
          false,
        );
        if (!assessment.complete)
          throw new Error(assessment.problems.join('. '));
        option.reviewed = {
          at: new Date().toISOString(),
          by: actor,
          terms: Object.fromEntries(
            quoteIds.map((id) => [
              id,
              packageTerms(quotes.find((q) => q.id === id)!),
            ]),
          ),
        };
      }
      plan.options = [
        ...plan.options.filter((o) => o.id !== option.id),
        option,
      ];
    } else if (input.action === 'SELECT') {
      const option = plan.options.find((o) => o.id === input.optionId);
      if (!option) throw new Error('Choose a package option');
      if (
        previouslySelected &&
        previouslySelected.id !== option.id &&
        previouslySelected.quoteIds.some((id) =>
          quotes.some(
            (q) => q.id === id && (q.status === 'BOUND' || q.bindAuthorizedAt),
          ),
        )
      )
        throw new Error(
          'This package is already in binding. Keep the remaining policies tracked.',
        );
      if (input.clientSelected !== true)
        throw new Error('Confirm the client selected this package');
      const assessment = packageAssessment(
        plan,
        option,
        quotes,
        agencyDay(new Date().toISOString()),
      );
      if (!assessment.complete) throw new Error(assessment.problems.join('. '));
      plan.selectedOptionId = option.id;
      plan.selectedAt ??= new Date().toISOString();
      plan.selectedTerms = Object.fromEntries(
        option.quoteIds.map((id) => [
          id,
          packageTerms(quotes.find((q) => q.id === id)!),
        ]),
      );
    } else if (input.action === 'CLEAR_SELECTION') {
      const option = plan.options.find((o) => o.id === plan.selectedOptionId);
      if (
        option?.quoteIds.some((id) =>
          quotes.some(
            (q) => q.id === id && (q.status === 'BOUND' || q.bindAuthorizedAt),
          ),
        )
      )
        throw new Error(
          'This package is already in binding. Keep the remaining policies tracked.',
        );
      plan.selectedOptionId = null;
      plan.selectedTerms = undefined;
      plan.selectedAt = undefined;
    } else if (input.action === 'REMOVE_OPTION') {
      if (input.optionId === plan.selectedOptionId)
        throw new Error('Clear the client selection first');
      plan.options = plan.options.filter((o) => o.id !== input.optionId);
    } else throw new Error('Unknown package action');
    // Fence every quote referenced by a saved/reviewed/selected option. Bound
    // statuses remain visible, but a concurrent term edit cannot bless stale terms.
    const relevant =
      input.action === 'SAVE_OPTION'
        ? (input.quoteIds as string[])
        : (plan.options.find(
            (o) => o.id === (plan.selectedOptionId ?? input.optionId),
          )?.quoteIds ?? []);
    for (const id of new Set([...relevant, ...guardedQuoteIds])) {
      const q = quotes.find((q) => q.id === id);
      if (!q) continue;
      writes.push({
        ConditionCheck: {
          TableName: process.env.QUOTE_TABLE!,
          Key: { id },
          ConditionExpression: 'updatedAt = :at',
          ExpressionAttributeValues: { ':at': q.updatedAt },
        },
      });
    }
  }
  plan = { ...plan, version: (old?.version ?? 0) + 1 };
  if (Buffer.byteLength(JSON.stringify(plan), 'utf8') > 300_000)
    throw new Error(
      'This account has too many package details. Remove unused options before saving.',
    );
  const wf = await get(`workflow:${accountId}`);
  await commit([
    absent(`deleted-account:${accountId}`),
    put(
      row('COMMERCIAL_PLAN', `commercial:${accountId}`, plan, {
        accountId,
        previous: old,
      }),
      old,
    ),
    ...writes,
    ...(wf ? [check(wf)] : []),
    {
      ConditionCheck: {
        TableName: process.env.ACCOUNT_TABLE!,
        Key: { id: accountId },
        ConditionExpression: 'updatedAt = :at',
        ExpressionAttributeValues: { ':at': account.data.updatedAt },
      },
    },
    audit(
      accountId,
      actor,
      input.action === 'ESTIMATE'
        ? 'Opportunity estimate updated'
        : 'Quote package updated',
      {
        action: input.action,
        optionId: input.optionId ?? null,
        estimatedCents: plan.estimatedCents,
      },
    ),
    ...(input.action !== 'ESTIMATE'
      ? [
          put(
            row(
              'LIFECYCLE',
              `lifecycle:package:${accountId}:${plan.version}`,
              { accountId },
              { accountId, dueAt: new Date().toISOString() },
            ),
          ),
        ]
      : []),
  ]);
  return plan;
}
