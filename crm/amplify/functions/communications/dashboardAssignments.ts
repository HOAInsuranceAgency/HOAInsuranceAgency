import { reportBatchGet, reportIds } from './dashboardStore';
import { table } from './store';

/** Admin-only report attribution. Commercial plans and reviewed quote terms
 * are intentionally absent; those are only needed for a selected work list. */
export async function dashboardAssignments(input: Record<string, unknown>) {
  const ids = reportIds(input.accountIds);
  const [workflows, accounts] = await Promise.all([
    reportBatchGet(table(), ids.map(id => `workflow:${id}`), ['data.salespersonId', 'data.disposition']),
    reportBatchGet(process.env.ACCOUNT_TABLE!, ids, ['name', 'leadSource', 'source']),
  ]);
  return { items: ids.map(accountId => {
    const workflow = workflows.get(`workflow:${accountId}`)?.data as { salespersonId?: string; disposition?: string } | undefined;
    return { accountId, salespersonId: workflow?.salespersonId, disposition: workflow?.disposition };
  }), accounts: [...accounts.values()] };
}
