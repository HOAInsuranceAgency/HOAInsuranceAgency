import { useMounted } from '../lib/useMounted';
import { useAgencyDay } from '../lib/useAgencyDay';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { client, listAllPages, fmtDate } from '../lib/client';
import { loadAccountRelationships, loadPartyIds, type AccountRelationshipRecord } from '../lib/relationships';
import { useAsyncResource } from '../lib/useAsyncResource';
import { isAuthorizationError } from '../lib/authorizationError';
import { RELATIONSHIP_LABELS, relationshipCurrent } from '../../../shared/relationships';
import { communicationRequest } from '../lib/communications';
import ManagementChangeForm from './ManagementChangeForm';
import RelationshipLinkForm from './RelationshipLinkForm';
import Modal from './Modal';
import '../pages/Relationships.css';
export default function AccountRelationships({
  accountId,
  onChanged,
}: {
  accountId: string;
  onChanged: () => void;
}) {
  const [historyToken, setHistoryToken] = useState<string>();
  const [params, setParams] = useSearchParams();
  const day = useAgencyDay();
  const [management, setManagement] = useState(false),
    [linking, setLinking] = useState(false),
    [ending, setEnding] = useState<AccountRelationshipRecord | null>(null),
    [notice, setNotice] = useState('');
  const resource = useAsyncResource(
    async () => {
      const [context, contacts] = await Promise.all([
        loadAccountRelationships(accountId, historyToken),
        listAllPages((nextToken) =>
          client.models.Contact.list({ filter: { accountId: { eq: accountId } }, nextToken }),
        ),
      ]);
      const parties = await loadPartyIds([
        ...context.relationships.map((r) => r.partyId),
        ...(params.get('partyId') ? [params.get('partyId')!] : []),
      ]);
      return { ...context, parties, contacts };
    },
    [accountId, historyToken, params.get('partyId')],
    {
      initialData: {
        relationships: [],
        version: 0,
        parties: [],
        contacts: [],
        nextToken: undefined as string | undefined,
        selfManagedFrom: undefined as string | undefined,
      },
      clearDataOnError: isAuthorizationError,
    },
  );
  useEffect(() => {
    if (params.get('management') === '1' && resource.loaded && !resource.error && !resource.loading)
      setManagement(true);
  }, [params, resource.loaded, resource.loading, resource.error]);
  function closeManagement() {
    setManagement(false);
    const next = new URLSearchParams(params);
    next.delete('management');
    next.delete('partyId');
    setParams(next, { replace: true });
  }
  async function saved() {
    closeManagement();
    setLinking(false);
    setEnding(null);
    setNotice('Relationship saved.');
    onChanged();
    if (historyToken) setHistoryToken(undefined);
    else await resource.refetch();
  }
  const display = (r: AccountRelationshipRecord) => (
    <li key={r.id}>
      <Link to={`/relationships/${r.partyId}`}>
        {resource.data.parties.find((p) => p.id === r.partyId)?.name ?? 'Relationship'}
      </Link>{' '}
      <span className="badge gray">{RELATIONSHIP_LABELS[r.role]}</span>
      <div className="relationship-dates">
        {r.validFrom ? fmtDate(r.validFrom) : 'Start date not recorded'}
        {r.validUntil ? ` to ${fmtDate(r.validUntil)} (exclusive)` : ' · Ongoing'}
      </div>
      {r.notes && <p className="small">{r.notes}</p>}
      {!r.validUntil && !['MANAGER', 'REFERRER'].includes(r.role) && (
        <button className="link" onClick={() => setEnding(r)}>
          End relationship
        </button>
      )}
    </li>
  );
  const current = resource.data.relationships.filter((r) => relationshipCurrent(r, day));
  const history = resource.data.relationships
    .filter((r) => !relationshipCurrent(r, day))
    .sort((a, b) => (b.validFrom ?? '').localeCompare(a.validFrom ?? ''));
  return (
    <section className="card" aria-label="Management and related people">
      <div className="card-head">
        <h2>Management and related people</h2>
        <div className="toolbar">
          <button
            className="secondary"
            disabled={resource.loading || !!resource.error}
            onClick={() => setManagement(true)}
          >
            Change management
          </button>
          <button
            className="secondary"
            disabled={resource.loading || !!resource.error}
            onClick={() => setLinking(true)}
          >
            Link relationship
          </button>
        </div>
      </div>
      {resource.error ? (
        <p className="error-text" role="alert">
          {resource.error}{' '}
          <button className="secondary" onClick={() => void resource.refetch()}>
            Retry
          </button>
        </p>
      ) : resource.loading ? (
        <p className="muted">Loading relationships…</p>
      ) : (
        <>
          {!current.length && !resource.data.selfManagedFrom ? (
            <p className="muted">
              No current relationships on this page. Link the company or people involved with this account.
            </p>
          ) : (
            <>
              <ul className="relationship-list">{current.map(display)}</ul>
              {resource.data.selfManagedFrom && (
                <p>
                  <strong>
                    {resource.data.selfManagedFrom <= day ? 'Self-managed' : 'Scheduled to be self-managed'}
                  </strong>{' '}
                  from {fmtDate(resource.data.selfManagedFrom)}
                </p>
              )}
            </>
          )}
          {history.length > 0 && (
            <details>
              <summary>History and scheduled changes ({history.length})</summary>
              <ul className="relationship-list">{history.map(display)}</ul>
            </details>
          )}
        </>
      )}
      {resource.data.nextToken && (
        <p>
          <button
            className="secondary"
            disabled={resource.loading}
            onClick={() => setHistoryToken(resource.data.nextToken)}
          >
            Next relationships page
          </button>
        </p>
      )}
      {historyToken && (
        <p>
          <button
            className="secondary"
            disabled={resource.loading}
            onClick={() => setHistoryToken(undefined)}
          >
            Back to first relationships page
          </button>
        </p>
      )}
      {notice && (
        <p role="status" className="muted small">
          {notice}
        </p>
      )}
      {management && !resource.error && (
        <ManagementChangeForm
          accountId={accountId}
          {...resource.data}
          initialPartyId={params.get('partyId') ?? undefined}
          onClose={closeManagement}
          onSaved={() => void saved()}
        />
      )}
      {linking && (
        <RelationshipLinkForm
          accountId={accountId}
          onClose={() => setLinking(false)}
          onSaved={() => void saved()}
        />
      )}
      {ending && (
        <EndRelationship relationship={ending} onClose={() => setEnding(null)} onSaved={() => void saved()} />
      )}
    </section>
  );
}
function EndRelationship({
  relationship,
  onClose,
  onSaved,
}: {
  relationship: AccountRelationshipRecord;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [date, setDate] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const requestId = useRef(crypto.randomUUID()),
    pending = useRef(false);
  const mounted = useMounted();
  return (
    <Modal
      title="End relationship"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (pending.current) return;
          pending.current = true;
          setBusy(true);
          setError('');
          try {
            await communicationRequest(
              'relationshipEnd',
              {
                accountId: relationship.accountId,
                id: relationship.id,
                revision: relationship.revision,
                validUntil: date,
                requestId: requestId.current,
              },
              true,
            );
            if (mounted.current) onSaved();
          } catch (e) {
            if (mounted.current) setError(e instanceof Error ? e.message : 'Could not end relationship.');
          } finally {
            pending.current = false;
            if (mounted.current) setBusy(false);
          }
        }}
      >
        <label className="field">
          First day this relationship no longer applies
          <input
            type="date"
            value={date}
            required
            disabled={busy}
            onChange={(e) => {
              setDate(e.target.value);
              requestId.current = crypto.randomUUID();
            }}
          />
        </label>
        <button className="primary" disabled={busy}>
          Save end date
        </button>
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
