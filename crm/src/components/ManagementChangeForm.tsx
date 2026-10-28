import PartyPicker from './PartyPicker';
import { useMounted } from '../lib/useMounted';
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Modal from './Modal';
import { communicationRequest } from '../lib/communications';
import { type Contact, fmtDate } from '../lib/client';
import type { PartyRecord, AccountRelationshipRecord } from '../lib/relationships';
import { relationshipCurrent } from '../../../shared/relationships';
import { agencyDay } from '../../../shared/leadActionGuidance';

export default function ManagementChangeForm({
  accountId,
  version,
  relationships,
  parties,
  contacts,
  initialPartyId,
  onClose,
  onSaved,
}: {
  accountId: string;
  version: number;
  relationships: AccountRelationshipRecord[];
  parties: PartyRecord[];
  contacts: Contact[];
  initialPartyId?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [partyId, setParty] = useState(initialPartyId ?? ''),
    [effectiveOn, setEffective] = useState(agencyDay(new Date().toISOString())),
    [generalPartyId, setGeneral] = useState(''),
    [billingPartyId, setBilling] = useState(''),
    [inspectionPartyId, setInspection] = useState(''),
    [retire, setRetire] = useState<string[]>([]),
    [notes, setNotes] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const mounted = useMounted();
  const requestId = useRef(crypto.randomUUID()),
    pending = useRef(false);
  const [selectedManager, setSelectedManager] = useState<PartyRecord>();
  const previous = relationships.filter((r) => r.role === 'MANAGER' && relationshipCurrent(r, effectiveOn));
  const managedContactIds = new Set(
    relationships.filter((r) => r.role === 'MANAGER' && !r.validUntil).flatMap((r) => r.contactIds ?? []),
  );
  const legacy = contacts.filter((c) => !managedContactIds.has(c.id) && relationshipCurrent(c, effectiveOn));
  const newName =
    selectedManager?.name ??
    parties.find((p) => p.id === partyId)?.name ??
    (partyId ? 'Selected manager' : 'Self-managed');
  function changed() {
    setConfirmed(false);
    requestId.current = crypto.randomUUID();
  }
  async function save() {
    if (pending.current || !confirmed) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await communicationRequest(
        'relationshipChangeManagement',
        {
          accountId,
          version,
          partyId: partyId || null,
          effectiveOn,
          generalPartyId: partyId ? generalPartyId || null : null,
          billingPartyId: partyId ? billingPartyId || null : null,
          inspectionPartyId: partyId ? inspectionPartyId || null : null,
          retireContactIds: retire,
          notes,
          requestId: requestId.current,
        },
        true,
      );
      if (mounted.current) onSaved();
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : 'Could not change management.');
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const select = (label: string, value: string, setter: (s: string) => void) => (
    <PartyPicker
      label={label}
      value={value}
      initial={[...parties, ...(selectedManager ? [selectedManager] : [])]}
      emptyLabel="Use remaining account contacts"
      onChange={(id) => {
        setter(id);
        changed();
      }}
      disabled={busy}
    />
  );
  return (
    <Modal
      title="Change management"
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
        <fieldset className="relationship-fields" disabled={busy}>
          <PartyPicker
            label="New manager"
            value={partyId}
            initial={[...parties, ...(selectedManager ? [selectedManager] : [])]}
            emptyLabel="Self-managed / no management company"
            onChange={(id, profile) => {
              setParty(id);
              setSelectedManager(profile);
              changed();
            }}
            disabled={busy}
          />
          <p className="muted small">
            Missing someone?{' '}
            <Link to="/relationships" target="_blank" rel="noreferrer">
              Add them to Relationships
            </Link>
            , then reopen this form.
          </p>
          <label className="field">
            Effective date
            <input
              type="date"
              required
              value={effectiveOn}
              onChange={(e) => {
                setEffective(e.target.value);
                changed();
              }}
            />
          </label>
          {partyId && (
            <>
              {select('General correspondence and forms', generalPartyId, setGeneral)}
              {select('Billing contact', billingPartyId, setBilling)}
              {select('Inspection contact', inspectionPartyId, setInspection)}
            </>
          )}
          <div>
            <strong>Other contacts leaving this account</strong>
            <p className="muted small">
              The previous management relationship’s linked contacts end automatically. Select any additional
              former representatives. Keep board members who still represent the account.
            </p>
            {legacy.length ? (
              legacy.map((c) => (
                <label className="relationship-checkbox" key={c.id}>
                  <input
                    type="checkbox"
                    checked={retire.includes(c.id)}
                    onChange={(e) => {
                      setRetire((old) =>
                        e.target.checked ? [...old, c.id] : old.filter((id) => id !== c.id),
                      );
                      changed();
                    }}
                  />
                  {c.name}
                  {c.email ? ` · ${c.email}` : ''}
                  {c.isPrimary ? ' · Primary' : ''}
                </label>
              ))
            ) : (
              <p className="muted">No additional current contacts.</p>
            )}
          </div>
          <label className="field">
            Handoff note
            <textarea
              maxLength={2000}
              rows={3}
              value={notes}
              onChange={(e) => {
                setNotes(e.target.value);
                changed();
              }}
            />
          </label>
          <div className="relationship-review">
            <strong>Review this change</strong>
            <p>
              {previous
                .map((r) => parties.find((p) => p.id === r.partyId)?.name ?? 'Previous manager')
                .join(', ') || 'No current management recorded'}{' '}
              → {newName}, effective {fmtDate(effectiveOn)}.
            </p>
            <p>
              The insured, policies, documents, original referral and salesperson remain attached to this
              account. Former contacts stay in history. Review existing Front conversations and drafts before
              sending to the new representatives.
            </p>
            {!generalPartyId && (
              <p>
                No new general contact selected. The remaining current account contacts will be used; if none
                remain, forms will have blank contact details.
              </p>
            )}
          </div>
          <label className="relationship-checkbox">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              required
            />
            I reviewed the effective date and contact handoff.
          </label>
          <div className="form-actions">
            <button className="primary" type="submit" disabled={!confirmed}>
              {busy ? 'Saving…' : 'Save management change'}
            </button>
            <button className="secondary" type="button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </fieldset>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
