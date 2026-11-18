import { useState } from 'react';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Select } from './ui/Select';
import { SaveStatus, useSaveStatus } from './SaveStatus';
import { communicationRequest } from '../lib/communications';
import { useAsyncResource } from '../lib/useAsyncResource';
import { useLiveUpdateBlock } from '../lib/useLiveUpdates';
import type { SalespersonAccessPolicy } from '../../../shared/salespersonAccess';
import './SalespersonAccessSettings.css';

export default function SalespersonAccessSettings() {
  const resource = useAsyncResource(() => communicationRequest('salespersonAccessSettings'), [], { initialData: null, errorMessage: 'Could not load salesperson access.' });
  const [draft, setDraft] = useState<SalespersonAccessPolicy | null>(null);
  const status = useSaveStatus();
  useLiveUpdateBlock(!!draft || status.busy);
  const policy = draft ?? resource.data?.policy;
  function change(patch: Partial<SalespersonAccessPolicy>) {
    if (policy) { setDraft({ ...policy, ...patch }); status.markDirty(); }
  }
  return <section className="card salesperson-access" aria-labelledby="salesperson-access-title">
    <h2 id="salesperson-access-title">Salesperson access</h2>
    <p className="muted small">Controls access to other salespeople’s accounts. Assigned accounts keep their existing permissions.</p>
    {resource.error && <p role="alert">{resource.error} <Button onClick={() => { setDraft(null); void resource.refetch(); }}>Reload settings</Button></p>}
    {!policy ? <p>Loading access settings…</p> : <>
      <fieldset className="salesperson-access-grid" aria-label="Salesperson access controls" disabled={status.busy || resource.loading || !!resource.error}>
        <div className="salesperson-access-section">
        <h3>Visibility</h3>
        <label className="salesperson-access-label" htmlFor="salesperson-visibility">Which accounts can salespeople see?</label>
        <Select id="salesperson-visibility" value={policy.visibility} onChange={e => change({ visibility: e.target.value as SalespersonAccessPolicy['visibility'] })}>
          <option value="ASSIGNED">Assigned only</option><option value="LEADS">All leads</option><option value="ALL">All leads and clients</option>
        </Select>
        <p className="muted small">Choose how broadly salespeople can browse the CRM.</p>
        </div>
        <div className="salesperson-access-section">
        <h3>Access level</h3>
        <label className="salesperson-access-label" htmlFor="salesperson-level">Access to other salespeople’s accounts</label>
        <Select id="salesperson-level" value={policy.level} onChange={e => change({ level: e.target.value as SalespersonAccessPolicy['level'] })}>
          <option value="READ">Read only</option><option value="COLLABORATE">Collaborate</option><option value="EDIT">Edit</option>
        </Select>
        <p className="muted small">{policy.level === 'READ' ? 'View account details and documents.' : policy.level === 'COLLABORATE' ? 'View details, add notes, and upload documents.' : 'Collaborate and edit account details, contacts, and draft quotes.'}</p>
        </div>
        <div className="salesperson-access-section">
        <h3>Additional permissions</h3>
        {([['send', 'Send emails and proposals', 'Allow sending emails and proposals'], ['invoice', 'Create, send, and void invoices', 'Allow creating, sending, and voiding invoices'], ['bind', 'Bind policies', 'Allow binding policies']] as const).map(([key, label, accessibleLabel]) => <label key={key} className="salesperson-access-check">
          <Input type="checkbox" aria-label={accessibleLabel} checked={policy[key]} onChange={e => change({ [key]: e.target.checked })} /> <span>{label}</span>
        </label>)}
        </div>
      </fieldset>
      <div className="salesperson-access-footer">
      <p className="muted small salesperson-access-summary">{policy.visibility === 'ASSIGNED' ? 'Additional permissions apply when broader visibility is selected.' : `Other ${policy.visibility === 'LEADS' ? 'leads' : 'leads and clients'} will be available with ${policy.level === 'READ' ? 'read-only' : policy.level === 'COLLABORATE' ? 'collaboration' : 'editing'} access.`} Assignment, sales credit, private compensation, and administrator permissions remain unchanged.</p>
      <div className="inline-actions salesperson-access-actions">
        <Button variant="primary" disabled={!draft || status.busy || resource.loading || !!resource.error} onClick={() => void status.run(async () => {
          if (!draft || !resource.data) return;
          const saved = await communicationRequest('saveSalespersonAccessSettings', { policy: draft, version: resource.data.version }, true);
          resource.setData(saved); setDraft(null);
        }, { savedMessage: 'Salesperson access saved.', errorMessage: 'Could not save access settings.' })}>Save access settings</Button>
        {draft && <Button disabled={status.busy} onClick={() => { setDraft(null); status.markDirty(); }}>Discard changes</Button>}
        {status.status.state === 'error' && <Button disabled={status.busy} onClick={() => { setDraft(null); status.markDirty(); void resource.refetch(); }}>Reload settings</Button>}
        <SaveStatus {...status.status} />
      </div>
      {resource.data?.updatedAt && <p className="muted small salesperson-access-updated">Last changed {new Date(resource.data.updatedAt).toLocaleString()}.</p>}
      </div>
    </>}
  </section>;
}
