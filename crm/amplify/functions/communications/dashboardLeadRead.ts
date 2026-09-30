import { dashboardLeadSelection, type DashboardLeadSelection } from '../../../../shared/dashboardLeadSelection';
import type { CommercialPlan } from '../../../../shared/quotePackages';
import { query } from './store';

/** One bounded indexed page. Do not hydrate every client's package in the CRM
 * just to discover the minority whose selected package is still in progress. */
export async function dashboardLeadPlansPage(input: Record<string, unknown>) {
  const token = input.nextToken;
  if (token !== undefined && (typeof token !== 'string' || token.length > 4000)) throw new Error('Invalid page token');
  if (typeof token === 'string') {
    try {
      const cursor = JSON.parse(Buffer.from(token, 'base64url').toString()) as Record<string, unknown>;
      if (!cursor || Object.keys(cursor).length !== 2 || cursor.kind !== 'COMMERCIAL_PLAN' || typeof cursor.id !== 'string' || !/^commercial:[a-zA-Z0-9_-]{1,100}$/.test(cursor.id)) throw new Error();
    } catch { throw new Error('Invalid page token'); }
  }
  const page = await query<CommercialPlan>('kind', 'COMMERCIAL_PLAN', token as string | undefined, 100);
  const items: DashboardLeadSelection[] = [];
  let bytes = 0;
  for (let index = 0; index < page.items.length; index++) {
    const record = page.items[index];
    const compact = dashboardLeadSelection(record.data);
    const size = compact ? Buffer.byteLength(JSON.stringify(compact), 'utf8') : 0;
    // Resuming at the last consumed GSI key retains any unvisited record when
    // an unusually large legacy package would exceed the response budget.
    if (bytes + size > 400_000 && index > 0) {
      const previous = page.items[index - 1];
      return { items, nextToken: Buffer.from(JSON.stringify({ id: previous.id, kind: 'COMMERCIAL_PLAN' })).toString('base64url') };
    }
    if (size > 400_000) throw new Error('A selected package is too large to report. Review its quote options.');
    if (compact) { items.push(compact); bytes += size; }
  }
  return { items, nextToken: page.nextToken };
}
