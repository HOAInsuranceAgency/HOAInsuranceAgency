import { useRef, useState } from 'react';
import { communicationRequest } from '../lib/communications';
import { fmtDate, friendlyError } from '../lib/client';
import { addCalendarDays } from '../../../shared/renewalPolicy';
import { leadSnoozeStatus, validateLeadSnooze, type LeadSnooze } from '../../../shared/leadSnooze';
import './LeadSnoozeControl.css';
import { useRowInteraction, type InteractionChange } from '../lib/useRefreshOnReturn';

export function LeadSnoozeControl({ accountName, snooze, today, onSaved, onRefresh, onInteractionChange }: {
  accountName: string;
  snooze: LeadSnooze;
  today: string;
  onSaved: (snooze: LeadSnooze) => void;
  onRefresh: () => Promise<void>;
  onInteractionChange?: InteractionChange;
}) {
  const [editing, setEditing] = useState(false);
  const [editingVersion, setEditingVersion] = useState(snooze.version);
  const [followUpOn, setFollowUpOn] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const status = leadSnoozeStatus(snooze, today);
  useRowInteraction(`snooze:${snooze.accountId}`, editing || busy, onInteractionChange);

  async function save(date: string | null, nextNote: string, version = snooze.version) {
    if (saving.current) return;
    saving.current = true;
    setBusy(true); setError('');
    try {
      const fields = validateLeadSnooze(date, nextNote, today);
      const result = await communicationRequest<{ snooze: LeadSnooze }>('saveLeadSnooze', {
        accountId: snooze.accountId, version, ...fields,
      }, true);
      onSaved(result.snooze);
      setEditing(false);
    } catch (err) {
      setError(friendlyError(err, 'Could not save the follow-up. Try again.'));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  return <div className="lead-snooze-control" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    {snooze.followUpOn && <div className="lead-snooze-summary">
      <span className={`badge ${status === 'DUE' ? 'amber' : 'gray'}`}>{status === 'DUE' ? 'Follow-up due' : 'Snoozed'}</span>
      <time dateTime={snooze.followUpOn}>{fmtDate(snooze.followUpOn)}</time>
      {snooze.note && <p className="small">{snooze.note}</p>}
    </div>}
    {editing ? <form onSubmit={event => { event.preventDefault(); void save(followUpOn, note, editingVersion); }}>
      <label className="field">Follow-up date<input type="date" value={followUpOn} min={addCalendarDays(today, 1)} required disabled={busy} onChange={event => setFollowUpOn(event.target.value)} /></label>
      <label className="field">Follow-up note<textarea value={note} placeholder="Optional — what to follow up on" maxLength={1000} rows={2} disabled={busy} onChange={event => setNote(event.target.value)} /></label>
      <div className="form-actions"><button className="primary" disabled={busy}>Snooze lead</button><button type="button" className="secondary" disabled={busy} onClick={() => { setEditing(false); setError(''); }}>Cancel</button></div>
    </form> : <div className="lead-snooze-actions">
      <button className="link" aria-label={snooze.followUpOn ? `Edit follow-up for ${accountName}` : `Snooze ${accountName}`} disabled={busy} onClick={() => {
        setEditingVersion(snooze.version);
        setFollowUpOn(status === 'SNOOZED' ? snooze.followUpOn! : addCalendarDays(today, 1)); setNote(snooze.note); setEditing(true); setError('');
      }}>{snooze.followUpOn ? 'Reschedule' : 'Snooze'}</button>
      {snooze.followUpOn && <button className="link" disabled={busy} onClick={() => void save(null, '')}>{status === 'DUE' ? 'Mark followed up' : 'Bring back now'}</button>}
    </div>}
    {busy && <p className="muted small" role="status">Saving…</p>}
    {error && <p className="error-text small" role="alert">{error} <button className="link" disabled={busy} onClick={() => { setEditing(false); setError(''); void onRefresh(); }}>Refresh</button></p>}
  </div>;
}
