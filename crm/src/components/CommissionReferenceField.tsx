import { useContext, useId, useState } from 'react';
import { listAllPages } from '../../../shared/pagination';
import { isAuthorizationError } from '../../../shared/authorizationError';
import { client } from '../lib/client';
import { useAsyncResource } from '../lib/useAsyncResource';
import { CommissionAccessContext } from '../features/commissions/context';
import { Input } from './ui/Input';
import { Button } from './ui/Button';

type Scope = { entityType: 'ACCOUNT' | 'CARRIER'; entityId: string; policyId?: string; quoteId?: string };
type DocumentReference = { id: string; name: string; entityId: string; entityType: string;
  policyId?: string | null; quoteId?: string | null; policyIds?: (string | null)[] | null; quoteIds?: (string | null)[] | null };
export function applicableReferenceDocument(document: DocumentReference, scope: Scope): boolean {
  if (document.entityId !== scope.entityId || document.entityType !== scope.entityType) return false;
  if (!scope.policyId) return true;
  const policies = [document.policyId, ...(document.policyIds ?? [])].filter(Boolean);
  const quotes = [document.quoteId, ...(document.quoteIds ?? [])].filter(Boolean);
  return (!policies.length && !quotes.length) || policies.includes(scope.policyId) || !!(scope.quoteId && quotes.includes(scope.quoteId));
}
const useful = (value: string) => !!value.trim() && !/^(?:[-–—?]+|n\/?a|none)$/i.test(value.trim());
/** Native combobox: reuse a saved reference without preventing a new external source. */
export default function CommissionReferenceField({ label, value, change, references = [], scope, onError } : {
  label: string; value: string; change: (value: string) => void; references?: (string | undefined)[];
  scope?: Scope; onError?: (error: unknown) => void;
}) {
  const listId = useId();
  const [requested, setRequested] = useState(false);
  const invalidate = useContext(CommissionAccessContext);
  const documents = useAsyncResource(async () => {
    if (!requested || !scope?.entityId) return [];
    try {
      const rows = await listAllPages(async nextToken => {
        const page = await client.models.Document.listDocumentByEntityId({ entityId: scope.entityId }, {
          filter: { entityType: { eq: scope.entityType } }, nextToken,
          selectionSet: ['id','name','entityId','entityType','policyId','quoteId','policyIds','quoteIds'],
        });
        if (page.errors?.length) {
          const denied = page.errors.find(isAuthorizationError);
          throw Object.assign(new Error((denied ?? page.errors[0]).message), denied ? { name: 'Unauthorized' } : {});
        }
        return page;
      });
      return rows.filter(row => applicableReferenceDocument(row, scope));
    } catch (error) {
      if (isAuthorizationError(error)) invalidate(error);
      onError?.(error);
      throw error;
    }
  }, [requested, scope?.entityId, scope?.entityType, scope?.policyId, scope?.quoteId], { initialData: [], clearDataOnError: () => true });
  const choices = [...new Set([value, ...references].filter((v): v is string => typeof v === 'string' && useful(v)))];
  return <div>
    <label className="field">{label}<Input required maxLength={2000} value={value} list={listId}
      onFocus={() => setRequested(true)} onChange={e => change(e.target.value)} />
      <datalist id={listId}>
        {choices.map(reference => <option key={reference} value={reference} />)}
        {documents.data.map(document => <option key={document.id} value={`CRM document: ${document.name} [${document.id}]`} label={document.name} />)}
      </datalist>
    </label>
    <p className="small muted">Choose a saved reference from the list, or enter a new external reference. Confirm that the selected record supports this decision.</p>
    {documents.loading && requested && scope && <p role="status">Finding applicable documents…</p>}
    {documents.error && <p role="alert">{documents.error} <Button type="button" variant="secondary" onClick={() => void documents.refetch()}>Retry reference documents</Button></p>}
  </div>;
}
