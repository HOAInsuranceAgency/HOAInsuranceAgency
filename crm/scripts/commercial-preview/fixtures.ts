import {
  emptyCommercialPlan,
  packageAssessment,
  packageTerms,
  parseEstimate,
  type CommercialPlan,
} from '../../../shared/quotePackages';
import type { Account, Quote, Carrier } from '../../src/lib/client';
export type {
  Account,
  Quote,
  Carrier,
  Contact,
  Policy,
} from '../../src/lib/client';
export type { TeamEligibility } from '../../../shared/leadWorkflow';
export { listAllPages } from '../../src/lib/pagination';
export const LINES_OF_BUSINESS = [
  'Property',
  'General Liability',
  'D&O',
  'Umbrella',
  'Crime',
];
export const fmtMoney = (value?: number | null) =>
  value == null
    ? '—'
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 0,
      }).format(value);
export const fmtNum = (value?: number | null) =>
  value == null ? '—' : String(value);
export const fmtDate = (value?: string | null) =>
  value
    ? new Date(`${value.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US')
    : '—';
export const fmtDateTime = (value?: string | null) =>
  value ? new Date(value).toLocaleString('en-US') : '—';
export const daysUntil = (value: string) =>
  Math.round((Date.parse(value) - Date.now()) / 86400000);
export const friendlyError = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
export const accounts = [
  {
    id: 'willow',
    name: 'Willow Court Condominium',
    type: 'ASSOCIATION',
    stage: 'LEAD',
    city: 'Boston',
    state: 'MA',
    source: 'website-quote',
    leadSource: 'GOOGLE_AD_WEBSITE',
    createdAt: '2026-09-01T13:00:00Z',
    currentPolicyExpiration: '2026-10-01',
    unitCount: 24,
    totalInsuredValue: 4000000,
  },
  {
    id: 'pine',
    name: 'Pine Grove Association',
    type: 'ASSOCIATION',
    stage: 'LEAD',
    city: 'Providence',
    state: 'RI',
    source: 'website-ho6:pine',
    leadSource: 'ORGANIC_WEBSITE',
    createdAt: '2026-09-04T13:00:00Z',
    currentPolicyExpiration: '2026-11-01',
    unitCount: 12,
  },
  {
    id: 'cedar',
    name: 'Cedar House — partially bound',
    type: 'ASSOCIATION',
    stage: 'CLIENT',
    city: 'Worcester',
    state: 'MA',
    source: 'website-contact',
    leadSource: 'ORGANIC_WEBSITE',
    createdAt: '2026-08-01T13:00:00Z',
    currentPolicyExpiration: '2026-10-01',
    unitCount: 18,
  },
] as unknown as Account[];
const q = (
  accountId: string,
  id: string,
  lines: string[],
  premium: number,
  status = 'QUOTED',
) =>
  ({
    id,
    accountId,
    carrierId: id,
    status,
    lines,
    premium,
    commissionPct: 10,
    effectiveDate: '2026-10-01',
    expirationDate: '2027-10-01',
    offerExpiresAt: '2026-09-30',
    createdAt: '2026-09-14T13:00:00Z',
    updatedAt: '2026-09-14T13:00:00Z',
  }) as unknown as Quote;
export const quotes = [
  q('willow', 'bundle', ['Property', 'D&O'], 15000),
  q('willow', 'property', ['Property'], 11000),
  q('willow', 'do', ['D&O'], 2500),
  q('cedar', 'cedar-property', ['Property'], 11000, 'BOUND'),
  q('cedar', 'cedar-do', ['D&O'], 2500),
];
export const carriers = quotes.map((q, i) => ({
  id: q.id,
  name: [
    'Harbor Mutual',
    'Pine Insurance',
    'Summit Specialty',
    'Cedar Mutual',
    'Cedar Specialty',
  ][i],
})) as Carrier[];
const option = (id: string, quoteIds: string[]) => ({
  id,
  name: id === 'bundle' ? 'One bundled policy' : 'Separate property and D&O',
  quoteIds,
  reviewed: {
    at: '2026-09-14T13:00:00Z',
    by: 'champ',
    terms: Object.fromEntries(
      quoteIds.map((id) => [
        id,
        packageTerms(quotes.find((q) => q.id === id)!),
      ]),
    ),
  },
});
export const plans: Record<string, CommercialPlan> = {
  willow: {
    ...emptyCommercialPlan('willow'),
    version: 1,
    estimatedCents: 180000,
    requiredLines: ['Property', 'D&O'],
    options: [
      option('bundle', ['bundle']),
      option('separate', ['property', 'do']),
    ],
  },
  pine: emptyCommercialPlan('pine'),
  cedar: {
    ...emptyCommercialPlan('cedar'),
    version: 1,
    estimatedCents: 160000,
    requiredLines: ['Property', 'D&O'],
    options: [option('cedar', ['cedar-property', 'cedar-do'])],
    selectedOptionId: 'cedar',
    selectedTerms: option('cedar', ['cedar-property', 'cedar-do']).reviewed
      .terms,
  },
};
export const team = [
  { userId: 'sales', name: 'Avery Brooks', salesperson: true, enabled: true },
  { userId: 'champ', name: 'Morgan Lane', champion: true, enabled: true },
];
export const client = {
  models: {
    Account: {
      list: async (args?: { filter?: { stage?: { eq: string } } }) => ({
        data: accounts.filter(
          (a) => !args?.filter?.stage?.eq || a.stage === args.filter.stage.eq,
        ),
      }),
    },
    Quote: { list: async () => ({ data: quotes }) },
    Contact: {
      list: async () => ({
        data: accounts.map((a) => ({
          id: `contact-${a.id}`,
          accountId: a.id,
          name: 'Jane Smith',
          email: 'jane@example.test',
          isPrimary: true,
        })),
      }),
    },
    Policy: {
      list: async () => ({
        data: [
          {
            id: 'cedar-policy',
            accountId: 'cedar',
            status: 'ACTIVE',
            expirationDate: '2027-10-01',
          },
        ],
      }),
    },
  },
};
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
