import { useState } from 'react';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Select } from './ui/Select';
import { SaveStatus, useSaveStatus } from './SaveStatus';
import { communicationRequest } from '../lib/communications';
import { useAsyncResource } from '../lib/useAsyncResource';
import { useLiveUpdateBlock } from '../lib/useLiveUpdates';
import type { SalespersonAccessPolicy } from '../../../shared/salespersonAccess';

export default function SalespersonAccessSettings() {
  const resource = useAsyncResource(() => communicationRequest('salespersonAccessSettings'), [], { initialData: null, errorMessage: 'Could not load salesperson access.' });
  const [draft, setDraft] = useState<SalespersonAccessPolicy | null>(null);
  const status = useSaveStatus();
  useLiveUpdateBlock(!!draft || status.busy);
  const policy = draft ?? resource.data?.policy;
  function change(patch: Partial<SalespersonAccessPolicy>) {
    if (policy) { setDraft({ ...policy, ...patch }); status.markDirty(); }
  }
  return <section className="card" aria-labelledby="salesperson-access-title">
    <h2 id="salesperson-access-title">Salesperson access</h2>
    <p className="muted small">Controls access to other salespeople’s accounts. Assigned accounts keep their existing permissions.</p>
    {resource.error && <p role="alert">{resource.error} <Button onClick={() => { setDraft(null); void resource.refetch(); }}>Reload settings</Button></p>}
    {!policy ? <p>Loading access settings…</p> : <>
      <fieldset disabled={status.busy || resource.loading || !!resource.error} style={{ border: 0, padding: 0 }}>
        <h3>Visibility</h3>
        <label htmlFor="salesperson-visibility">Which accounts can salespeople see?</label>
        <Select id="salesperson-visibility" value={policy.visibility} onChange={e => change({ visibility: e.target.value as SalespersonAccessPolicy['visibility'] })}>
          <option value="ASSIGNED">Assigned only</option><option value="LEADS">All leads</option><option value="ALL">All leads and clients</option>
        </Select>
        <h3>Access to other salespeople’s accounts</h3>
        <label htmlFor="salesperson-level">Access level</label>
        <Select id="salesperson-level" value={policy.level} onChange={e => change({ level: e.target.value as SalespersonAccessPolicy['level'] })}>
          <option value="READ">Read only</option><option value="COLLABORATE">Collaborate</option><option value="EDIT">Edit</option>
        </Select>
        <p className="muted small">Read only: view details and documents. Collaborate: also add notes and upload documents. Edit: also update account details, contacts, and draft quotes. Tasks are retired.</p>
        <h3>Additional permissions</h3>
        {([['send', 'Allow sending emails and proposals'], ['invoice', 'Allow creating, sending, and voiding invoices'], ['bind', 'Allow binding policies']] as const).map(([key, label]) => <label key={key} style={{ display: 'block', marginBottom: 8 }}>
          <Input type="checkbox" checked={policy[key]} onChange={e => change({ [key]: e.target.checked })} /> {label}
        </label>)}
      </fieldset>
      <p className="muted small">{policy.visibility === 'ASSIGNED' ? 'Only assigned accounts are accessible; additional permissions apply when broader visibility is selected.' : `Other ${policy.visibility === 'LEADS' ? 'leads' : 'leads and clients'} will be available with ${policy.level === 'READ' ? 'read-only' : policy.level === 'COLLABORATE' ? 'collaboration' : 'editing'} access.`} Assignment, sales credit, private compensation, and administrator permissions remain unchanged.</p>
      <div className="inline-actions">
        <Button variant="primary" disabled={!draft || status.busy || resource.loading || !!resource.error} onClick={() => void status.run(async () => {
          if (!draft || !resource.data) return;
          const saved = await communicationRequest('saveSalespersonAccessSettings', { policy: draft, version: resource.data.version }, true);
          resource.setData(saved); setDraft(null);
        }, { savedMessage: 'Salesperson access saved.', errorMessage: 'Could not save access settings.' })}>Save access settings</Button>
        {draft && <Button disabled={status.busy} onClick={() => { setDraft(null); status.markDirty(); }}>Discard changes</Button>}
        {status.status.state === 'error' && <Button disabled={status.busy} onClick={() => { setDraft(null); status.markDirty(); void resource.refetch(); }}>Reload settings</Button>}
        <SaveStatus {...status.status} />
      </div>
      {resource.data?.updatedAt && <p className="muted small">Last changed {new Date(resource.data.updatedAt).toLocaleString()}.</p>}
    </>}
  </section>;
}
