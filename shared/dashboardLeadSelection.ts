import { alternativeQuoteIds, type CommercialPlan } from './quotePackages';

/** Reporting needs selected quote membership, never package reviews or signed terms. */
export interface DashboardLeadSelection {
  accountId: string;
  selectedQuoteIds: string[];
  alternativeQuoteIds: string[];
}

export function dashboardLeadSelection(plan: CommercialPlan): DashboardLeadSelection | null {
  const selected = plan.options.find(option => option.id === plan.selectedOptionId);
  return selected ? {
    accountId: plan.accountId,
    selectedQuoteIds: [...selected.quoteIds],
    alternativeQuoteIds: alternativeQuoteIds(plan),
  } : null;
}

/** Missing or withdrawn selected quotes still leave a package unfinished. */
export function unfinishedSelectedPackage(selection: DashboardLeadSelection | undefined, quotes: readonly { id?: string; accountId: string; status?: string | null }[]): boolean {
  return !!selection?.selectedQuoteIds.some(id => !quotes.some(quote => quote.id === id && quote.accountId === selection.accountId && quote.status === 'BOUND'));
}
