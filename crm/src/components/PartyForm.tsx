import { useLiveUpdateBlock } from "../lib/useLiveUpdates";
import { Select } from "./ui/Select";
import { Input } from "./ui/Input";
import { Button } from "./ui/Button";
import { Textarea } from "./ui/Textarea";
import { usePagedList } from '../lib/usePagedList';
import { useRef } from 'react';
import { useFormState } from '../lib/useFormState';
import { useSaveStatus } from './SaveStatus';
import Modal from './Modal';
import { communicationRequest } from '../lib/communications';
import { searchParties, type PartyRecord } from '../lib/relationships';
import { useIsAdmin } from '../lib/auth';
import { useAsyncResource } from '../lib/useAsyncResource';

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
  useLiveUpdateBlock(true);
  const saveStatus = useSaveStatus({ singleFlight: true });
  const { busy } = saveStatus;
  const error = saveStatus.status.state === 'error' ? saveStatus.status.message : '';
  const { form, setF } = useFormState(() => ({
    kind: seed?.kind ?? 'ORGANIZATION',
    name: seed?.name ?? '',
    category: seed?.category ?? 'Property management',
    email: seed?.email ?? '',
    phone: seed?.phone ?? '',
    website: seed?.website ?? '',
    notes: seed?.notes ?? '',
    ownerId: seed?.ownerId ?? '',
    archived: seed?.archived ?? false,
  }), { onEdit: saveStatus.markDirty });
  const requestId = useRef(crypto.randomUUID());
  const admin = useIsAdmin();
  const team = useAsyncResource(
    async () => (admin ? (await communicationRequest('team')).team : []),
    [admin],
    { initialData: [] , live: true },
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
  function change<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setF(key, value);
    requestId.current = crypto.randomUUID();
  }
  async function save() {
    await saveStatus.run(async current => {
      const result = await communicationRequest(
        'relationshipSaveParty',
        { ...form, id: party?.id, revision: party?.revision ?? 0, requestId: requestId.current },
        true,
      );
      if (current()) onSaved(result.party);
    }, { errorMessage: 'Could not save this profile.' });
  }
  return (
    <Modal
      title={party ? `Edit ${party.name}` : 'New relationship'}
      onClose={() => {
        if (!saveStatus.isPending()) onClose();
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
            <Select value={form.kind} disabled={!!party} onChange={(e) => change('kind', e.target.value as PartyRecord['kind'])}>
              <option value="ORGANIZATION">Organization</option>
              <option value="PERSON">Person</option>
            </Select>
          </label>
          <label className="field">
            Name
            <Input
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
                  <Button type="button" onClick={() => void nameMatches.more()}>
                    Retry name check
                  </Button>
                </p>
              )}
              {emailMatches.error && (
                <p role="alert">
                  {emailMatches.error}{' '}
                  <Button type="button" onClick={() => void emailMatches.more()}>
                    Retry email check
                  </Button>
                </p>
              )}
              {nameMatches.nextToken && (
                <p>
                  <Button variant="secondary"
                    type="button"

                    disabled={nameMatches.loading}
                    onClick={() => void nameMatches.more()}
                  >
                    Continue checking name matches
                  </Button>
                </p>
              )}
              {emailMatches.nextToken && (
                <p>
                  <Button variant="secondary"
                    type="button"

                    disabled={emailMatches.loading}
                    onClick={() => void emailMatches.more()}
                  >
                    Continue checking email matches
                  </Button>
                </p>
              )}
              {matches.map((p) => (
                <p key={p.id}>
                  {p.name}
                  {p.email ? ` · ${p.email}` : ''}{' '}
                  <Button variant="secondary"  type="button" onClick={() => onSaved(p)}>
                    Use existing profile
                  </Button>
                </p>
              ))}
            </div>
          )}
          <label className="field">
            Category
            <Input
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
            <Input
              type="email"
              maxLength={320}
              value={form.email}
              onChange={(e) => change('email', e.target.value)}
            />
          </label>
          <label className="field">
            Phone
            <Input
              type="tel"
              maxLength={80}
              value={form.phone}
              onChange={(e) => change('phone', e.target.value)}
            />
          </label>
          <label className="field">
            Website
            <Input
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
              <Select value={form.ownerId} onChange={(e) => change('ownerId', e.target.value)}>
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
              </Select>
            </label>
          )}
          <label className="field">
            Relationship notes
            <Textarea
              rows={4}
              maxLength={5000}
              value={form.notes}
              onChange={(e) => change('notes', e.target.value)}
            />
          </label>
          {party && (
            <label>
              <Input
                type="checkbox"
                checked={form.archived}
                onChange={(e) => change('archived', e.target.checked)}
              />{' '}
              Archive this profile (history remains)
            </label>
          )}
          <div className="form-actions">
            <Button variant="primary"  type="submit">
              {busy ? 'Saving…' : 'Save relationship'}
            </Button>
            <Button variant="secondary"  type="button" onClick={onClose}>
              Cancel
            </Button>
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
