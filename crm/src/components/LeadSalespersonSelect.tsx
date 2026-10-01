import { useId, useRef, useState } from 'react';
import { useIsAdmin } from '../lib/auth';
import { friendlyError } from '../lib/client';
import { communicationRequest, type LeadWorkflow, type TeamEligibility } from '../lib/communications';

export function LeadSalespersonSelect({
  accountId, accountName, salespersonId, workflowVersion, team, onSaved, onRefresh,
}: {
  accountId: string;
  accountName: string;
  salespersonId?: string;
  workflowVersion: number;
  team: TeamEligibility[];
  onSaved: (workflow: LeadWorkflow) => void;
  onRefresh: () => Promise<void>;
}) {
  const isAdmin = useIsAdmin();
  const messageId = useId();
  const saving = useRef(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const eligible = team.filter(member => member.enabled && member.salesperson);

  async function assign(nextId: string) {
    if (!isAdmin || saving.current || !nextId || nextId === salespersonId) return;
    saving.current = true;
    setPending(nextId);
    setError('');
    setSaved(false);
    try {
      const result = await communicationRequest<{ workflow: LeadWorkflow }>(
        'setResponsibilities', { accountId, salespersonId: nextId, version: workflowVersion }, true,
      );
      onSaved(result.workflow);
      setSaved(true);
    } catch (err) {
      setError(friendlyError(err, 'Could not change salesperson. Try again.'));
    } finally {
      saving.current = false;
      setPending(null);
    }
  }

  if (!isAdmin) return null;
  return (
    <div className="lead-salesperson" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
      <select
        aria-label={`Salesperson for ${accountName}`}
        aria-describedby={messageId}
        aria-invalid={!!error}
        value={pending ?? salespersonId ?? ''}
        disabled={pending !== null || eligible.length === 0}
        onChange={event => void assign(event.target.value)}
      >
        <option value="" disabled>Unassigned</option>
        {salespersonId && !eligible.some(member => member.userId === salespersonId) && (
          <option value={salespersonId} disabled>{team.find(member => member.userId === salespersonId)?.name ?? 'Assigned teammate'} (unavailable)</option>
        )}
        {eligible.map(member => <option key={member.userId} value={member.userId}>{member.name}</option>)}
      </select>
      <div id={messageId}>
        {error ? <div className="error-text small" role="alert">{error} <button className="link" onClick={() => void onRefresh()}>Refresh assignments</button></div>
          : <span className="muted small" role="status">{pending !== null ? 'Saving…' : saved ? 'Saved' : eligible.length === 0 ? 'No eligible salespeople' : ''}</span>}
      </div>
    </div>
  );
}
