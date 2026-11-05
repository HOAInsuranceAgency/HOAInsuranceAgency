import { accountManagementPath } from '../../../shared/crmRoutes';
import { useLiveUpdateBlock } from "../lib/useLiveUpdates";
import { Select } from "./ui/Select";
import { Input } from "./ui/Input";
import { Textarea } from "./ui/Textarea";
import { Button } from "./ui/Button";
import PartyPicker from './PartyPicker';
import AccountPicker from './AccountPicker';
import { useRef } from 'react';
import { useFormState } from '../lib/useFormState';
import { useSaveStatus } from './SaveStatus';
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
  useLiveUpdateBlock(true);
  const saveStatus = useSaveStatus({ singleFlight: true });
  const { busy } = saveStatus;
  const error = saveStatus.status.state === 'error' ? saveStatus.status.message : '';
  const requestId = useRef(crypto.randomUUID());
  const { form, setF } = useFormState(() => ({ account: accountId ?? '', party: partyId ?? '',
    role: 'MANAGER' as RelationshipRole, from: '', notes: '' }), { onEdit: saveStatus.markDirty });
  const { account, party, role, from, notes } = form;
  function change<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setF(key, value);
    requestId.current = crypto.randomUUID();
  }
  async function save() {
    if (saveStatus.isPending() || !account || !party) return;
    if (role === 'MANAGER') {
      onClose();
      navigate(accountManagementPath(account, party));
      return;
    }
    await saveStatus.run(async current => {
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
      if (current()) onSaved();
    }, { errorMessage: 'Could not link this relationship.' });
  }
  return (
    <Modal
      title="Link an account relationship"
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
        <fieldset className="relationship-fields" disabled={busy}>
          {!accountId && (
            <AccountPicker
              value={account}
              disabled={busy}
              onChange={(id) => {
                change('account', id);
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
                change('party', id);
              }}
            />
          )}
          <label className="field">
            Role
            <Select
              value={role}
              onChange={(e) => {
                change('role', e.target.value as RelationshipRole);
              }}
            >
              {RELATIONSHIP_ROLES.map((r) => (
                <option key={r} value={r}>
                  {RELATIONSHIP_LABELS[r]}
                </option>
              ))}
            </Select>
          </label>
          {role === 'MANAGER' ? (
            <p className="muted">
              Continue to review the effective date and contact handoff on the insured account.
            </p>
          ) : (
            <>
              <label className="field">
                Start date (if known)
                <Input
                  type="date"
                  value={from}
                  onChange={(e) => {
                    change('from', e.target.value);
                  }}
                />
              </label>
              <label className="field">
                Account relationship notes
                <Textarea
                  maxLength={2000}
                  value={notes}
                  onChange={(e) => {
                    change('notes', e.target.value);
                  }}
                />
              </label>
            </>
          )}
          <Button variant="primary"  type="submit">
            {busy ? 'Saving…' : role === 'MANAGER' ? 'Review management change' : 'Link relationship'}
          </Button>
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
