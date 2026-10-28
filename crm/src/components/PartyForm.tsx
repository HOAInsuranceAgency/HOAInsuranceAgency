import { usePagedList } from '../lib/usePagedList';
import { useMounted } from '../lib/useMounted';
import { useRef, useState } from 'react';
import Modal from './Modal';
import { communicationRequest } from '../lib/communications';
import { searchParties, type PartyRecord } from '../lib/relationships';
import { useIsAdmin } from '../lib/auth';
import { useAsyncResource } from '../lib/useAsyncResource';
import type { TeamEligibility } from '../lib/communications';

export default function PartyForm({
  party,
  initial,
  onSaved,
  onClose,
}: {
  party?: PartyRecord;
  initial?: Partial<PartyRecord>;
  onSaved: (value: PartyRecord) => void;
  onClose: () => void;
}) {
  const seed = party ?? initial;
  const [form, setForm] = useState({
    kind: seed?.kind ?? 'ORGANIZATION',
    name: seed?.name ?? '',
    category: seed?.category ?? 'Property management',
    email: seed?.email ?? '',
    phone: seed?.phone ?? '',
    website: seed?.website ?? '',
    notes: seed?.notes ?? '',
    ownerId: seed?.ownerId ?? '',
    archived: seed?.archived ?? false,
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const mounted = useMounted();
  const pending = useRef(false),
    requestId = useRef(crypto.randomUUID());
  const admin = useIsAdmin();
  const team = useAsyncResource(
    async () => (admin ? (await communicationRequest<{ team: TeamEligibility[] }>('team')).team : []),
    [admin],
    { initialData: [] },
  );
  const nameQuery = form.name.trim(),
    emailQuery = form.email.trim();
  const nameMatches = usePagedList(
    (token) => searchParties(nameQuery, {}, token),
    [nameQuery],
    !party && nameQuery.length >= 3,
  );
  const emailMatches = usePagedList(
    (token) => searchParties(emailQuery, {}, token),
    [emailQuery],
    !party && emailQuery.includes('@'),
  );
  const matches = [...new Map([...nameMatches.items, ...emailMatches.items].map((p) => [p.id, p])).values()];
  function change(key: string, value: string | boolean) {
    setForm((old) => ({ ...old, [key]: value }));
    requestId.current = crypto.randomUUID();
  }
  async function save() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await communicationRequest<{ party: PartyRecord }>(
        'relationshipSaveParty',
        { ...form, id: party?.id, revision: party?.revision ?? 0, requestId: requestId.current },
        true,
      );
      if (mounted.current) onSaved(result.party);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : 'Could not save this profile.');
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <Modal
      title={party ? `Edit ${party.name}` : 'New relationship'}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className="muted small">
          Business contact details are shared with your team. Linked insured accounts retain their existing
          access restrictions.
        </p>
        <fieldset disabled={busy} className="relationship-fields">
          <label className="field">
            Record type
            <select value={form.kind} disabled={!!party} onChange={(e) => change('kind', e.target.value)}>
              <option value="ORGANIZATION">Organization</option>
              <option value="PERSON">Person</option>
            </select>
          </label>
          <label className="field">
            Name
            <input
              required
              maxLength={200}
              value={form.name}
              onChange={(e) => change('name', e.target.value)}
            />
          </label>
          {!party && (nameQuery.length >= 3 || emailQuery.includes('@')) && (
            <div className="relationship-review">
              <strong>Possible existing relationships</strong>
              <p className="muted small">
                Use an existing profile when it represents the same person or company.
              </p>
              {(nameMatches.loading || emailMatches.loading) && (
                <p className="muted small">Checking existing profiles…</p>
              )}
              {!matches.length && !nameMatches.loading && !emailMatches.loading && (
                <p className="muted small">No matches in the pages checked so far.</p>
              )}
              {nameMatches.error && (
                <p role="alert">
                  {nameMatches.error}{' '}
                  <button type="button" onClick={() => void nameMatches.more()}>
                    Retry name check
                  </button>
                </p>
              )}
              {emailMatches.error && (
                <p role="alert">
                  {emailMatches.error}{' '}
                  <button type="button" onClick={() => void emailMatches.more()}>
                    Retry email check
                  </button>
                </p>
              )}
              {nameMatches.nextToken && (
                <p>
                  <button
                    type="button"
                    className="secondary"
                    disabled={nameMatches.loading}
                    onClick={() => void nameMatches.more()}
                  >
                    Continue checking name matches
                  </button>
                </p>
              )}
              {emailMatches.nextToken && (
                <p>
                  <button
                    type="button"
                    className="secondary"
                    disabled={emailMatches.loading}
                    onClick={() => void emailMatches.more()}
                  >
                    Continue checking email matches
                  </button>
                </p>
              )}
              {matches.map((p) => (
                <p key={p.id}>
                  {p.name}
                  {p.email ? ` · ${p.email}` : ''}{' '}
                  <button className="secondary" type="button" onClick={() => onSaved(p)}>
                    Use existing profile
                  </button>
                </p>
              ))}
            </div>
          )}
          <label className="field">
            Category
            <input
              list="relationship-categories"
              maxLength={100}
              value={form.category}
              onChange={(e) => change('category', e.target.value)}
            />
            <datalist id="relationship-categories">
              <option>Property management</option>
              <option>Landlord</option>
              <option>Referral partner</option>
              <option>Board member</option>
              <option>Other</option>
            </datalist>
          </label>
          <label className="field">
            Email
            <input
              type="email"
              maxLength={320}
              value={form.email}
              onChange={(e) => change('email', e.target.value)}
            />
          </label>
          <label className="field">
            Phone
            <input
              type="tel"
              maxLength={80}
              value={form.phone}
              onChange={(e) => change('phone', e.target.value)}
            />
          </label>
          <label className="field">
            Website
            <input
              type="url"
              maxLength={1000}
              placeholder="https://"
              value={form.website}
              onChange={(e) => change('website', e.target.value)}
            />
          </label>
          {admin && (
            <label className="field">
              Relationship owner
              <select value={form.ownerId} onChange={(e) => change('ownerId', e.target.value)}>
                <option value="">Me</option>
                {party?.ownerId && !team.data.some((t) => t.userId === party.ownerId) && (
                  <option value={party.ownerId}>Current owner</option>
                )}
                {team.data
                  .filter((t) => t.available)
                  .map((t) => (
                    <option key={t.userId} value={t.userId}>
                      {t.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <label className="field">
            Relationship notes
            <textarea
              rows={4}
              maxLength={5000}
              value={form.notes}
              onChange={(e) => change('notes', e.target.value)}
            />
          </label>
          {party && (
            <label>
              <input
                type="checkbox"
                checked={form.archived}
                onChange={(e) => change('archived', e.target.checked)}
              />{' '}
              Archive this profile (history remains)
            </label>
          )}
          <div className="form-actions">
            <button className="primary" type="submit">
              {busy ? 'Saving…' : 'Save relationship'}
            </button>
            <button className="secondary" type="button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </fieldset>
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
