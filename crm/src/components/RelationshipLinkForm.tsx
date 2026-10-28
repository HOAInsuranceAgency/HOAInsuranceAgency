import PartyPicker from './PartyPicker';
import AccountPicker from './AccountPicker';
import { useMounted } from '../lib/useMounted';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Modal from './Modal';
import { communicationRequest } from '../lib/communications';
import {
  RELATIONSHIP_LABELS,
  RELATIONSHIP_ROLES,
  type RelationshipRole,
} from '../../../shared/relationships';
export default function RelationshipLinkForm({
  accountId,
  partyId,
  onClose,
  onSaved,
}: {
  accountId?: string;
  partyId?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const navigate = useNavigate();
  const [account, setAccount] = useState(accountId ?? ''),
    [party, setParty] = useState(partyId ?? ''),
    [role, setRole] = useState<RelationshipRole>('MANAGER'),
    [from, setFrom] = useState(''),
    [notes, setNotes] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const mounted = useMounted();
  const pending = useRef(false),
    requestId = useRef(crypto.randomUUID());
  function changed() {
    requestId.current = crypto.randomUUID();
  }
  async function save() {
    if (pending.current || !account || !party) return;
    if (role === 'MANAGER') {
      onClose();
      navigate(`/accounts/${account}?management=1&partyId=${encodeURIComponent(party)}`);
      return;
    }
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await communicationRequest(
        'relationshipLink',
        {
          accountId: account,
          partyId: party,
          role,
          validFrom: from || null,
          notes,
          requestId: requestId.current,
        },
        true,
      );
      if (mounted.current) onSaved();
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : 'Could not link this relationship.');
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <Modal
      title="Link an account relationship"
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
          {!accountId && (
            <AccountPicker
              value={account}
              disabled={busy}
              onChange={(id) => {
                setAccount(id);
                changed();
              }}
            />
          )}
          {!partyId && (
            <PartyPicker
              label="Person or organization"
              value={party}
              required
              disabled={busy}
              onChange={(id) => {
                setParty(id);
                changed();
              }}
            />
          )}
          <label className="field">
            Role
            <select
              value={role}
              onChange={(e) => {
                setRole(e.target.value as RelationshipRole);
                changed();
              }}
            >
              {RELATIONSHIP_ROLES.map((r) => (
                <option key={r} value={r}>
                  {RELATIONSHIP_LABELS[r]}
                </option>
              ))}
            </select>
          </label>
          {role === 'MANAGER' ? (
            <p className="muted">
              Continue to review the effective date and contact handoff on the insured account.
            </p>
          ) : (
            <>
              <label className="field">
                Start date (if known)
                <input
                  type="date"
                  value={from}
                  onChange={(e) => {
                    setFrom(e.target.value);
                    changed();
                  }}
                />
              </label>
              <label className="field">
                Account relationship notes
                <textarea
                  maxLength={2000}
                  value={notes}
                  onChange={(e) => {
                    setNotes(e.target.value);
                    changed();
                  }}
                />
              </label>
            </>
          )}
          <button className="primary" type="submit">
            {busy ? 'Saving…' : role === 'MANAGER' ? 'Review management change' : 'Link relationship'}
          </button>
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
