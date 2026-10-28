import { useMounted } from '../lib/useMounted';
import { useAgencyDay } from '../lib/useAgencyDay';
import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  loadPartyProfile,
  loadParties,
  type AffiliationRecord,
  type PartyRecord,
} from '../lib/relationships';
import { useAsyncResource } from '../lib/useAsyncResource';
import { useIsAdmin } from '../lib/auth';
import { isAuthorizationError } from '../lib/authorizationError';
import { RELATIONSHIP_LABELS, relationshipCurrent } from '../../../shared/relationships';
import { fmtDate } from '../lib/client';
import { communicationRequest } from '../lib/communications';
import PartyForm from '../components/PartyForm';
import RelationshipLinkForm from '../components/RelationshipLinkForm';
import Modal from '../components/Modal';
import './Relationships.css';
export default function RelationshipDetail() {
  const { id } = useParams();
  return <RelationshipProfile key={id} id={id!} />;
}
function RelationshipProfile({ id }: { id: string }) {
  const resource = useAsyncResource(
    async () => {
      const [profile, parties] = await Promise.all([loadPartyProfile(id), loadParties()]);
      return { ...profile, parties };
    },
    [id],
    { initialData: null, clearDataOnError: isAuthorizationError },
  );
  const [editing, setEditing] = useState(false),
    [linking, setLinking] = useState(false),
    [affiliation, setAffiliation] = useState<AffiliationRecord | 'new' | null>(null);
  const admin = useIsAdmin();
  const day = useAgencyDay();
  if (resource.error)
    return (
      <p role="alert" className="error-text">
        {resource.error} <button className="secondary" onClick={() => void resource.refetch()}>Retry</button>
      </p>
    );
  if (resource.loading || !resource.data) return <p>Loading relationship…</p>;
  const { party, parties, links, accounts, affiliations, actor } = resource.data;
  const canEdit = admin || party.ownerId === actor;
  const current = links.filter((r) => relationshipCurrent(r, day)),
    other = links.filter((r) => !relationshipCurrent(r, day));
  const name = (key: string) => parties.find((p) => p.id === key)?.name ?? 'Unavailable profile';
  const portfolio = (rows: typeof links) =>
    rows.length ? (
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Insured account</th>
              <th>Role</th>
              <th>Status</th>
              <th>Dates</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link to={`/accounts/${r.accountId}`}>{accounts.get(r.accountId)?.name}</Link>
                </td>
                <td>{RELATIONSHIP_LABELS[r.role]}</td>
                <td>{accounts.get(r.accountId)?.stage === 'CLIENT' ? 'Client' : 'Lead'}</td>
                <td>
                  {r.validFrom ? fmtDate(r.validFrom) : 'Start not recorded'}
                  {r.validUntil ? ` → ${fmtDate(r.validUntil)}` : ' · Ongoing'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : (
      <p className="muted">No linked accounts visible in this view.</p>
    );
  return (
    <>
      <Link to="/relationships">← Relationships</Link>
      <div className="relationship-heading">
        <div>
          <h1>{party.name}</h1>
          <p className="muted">
            {party.kind === 'PERSON' ? 'Person' : 'Organization'}
            {party.category && ` · ${party.category}`}
            {party.archived && ' · Archived'}
          </p>
        </div>
        <div className="toolbar">
          {canEdit && <button className="secondary" onClick={() => setEditing(true)}>Edit profile</button>}
          <button className="secondary" onClick={() => void resource.refetch()}>Refresh</button>
        </div>
      </div>
      <div className="relationship-grid">
        <div>
          <section className="card">
            <div className="card-head">
              <h2>Linked insured accounts</h2>
              {!party.archived && <button className="secondary" onClick={() => setLinking(true)}>Link existing account</button>}
            </div>
            <p className="muted small">
              Only accounts you can access are shown. Managing this relationship does not change
              insured-account assignments.
            </p>
            {portfolio(current)}
            {other.length > 0 && (
              <details>
                <summary>Former and scheduled relationships ({other.length})</summary>
                {portfolio(other)}
              </details>
            )}
            {!party.archived && (
              <p>
                <Link to={`/leads/new?relatedParty=${id}`}>
                  Create an insurance lead for this relationship →
                </Link>
              </p>
            )}
          </section>
          <section className="card">
            <div className="card-head">
              <h2>
                {party.kind === 'ORGANIZATION'
                  ? 'People and employment history'
                  : 'Organizations and employment history'}
              </h2>
              {canEdit && !party.archived && (
                <button className="secondary" onClick={() => setAffiliation('new')}>Add affiliation</button>
              )}
            </div>
            <ul className="relationship-list">
              {affiliations.map((a) => {
                const related = party.kind === 'PERSON' ? a.organizationId : a.personId;
                return (
                  <li key={a.id}>
                    <Link to={`/relationships/${related}`}>{name(related)}</Link>
                    {a.title && ` · ${a.title}`}
                    <div className="relationship-dates">
                      {a.validFrom ? fmtDate(a.validFrom) : 'Start not recorded'}
                      {a.validUntil ? ` → ${fmtDate(a.validUntil)}` : ' · Ongoing'}
                      {!relationshipCurrent(a, day) && ' · Former or scheduled'}
                    </div>
                    {canEdit && (
                      <button className="link" onClick={() => setAffiliation(a)}>
                        Edit dates / role
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
            {!affiliations.length && <p className="muted">No affiliations recorded.</p>}
          </section>
        </div>
        <aside>
          <section className="card">
            <h2>Business contact</h2>
            {party.email && (
              <p>
                <a href={`mailto:${party.email}`}>{party.email}</a>
              </p>
            )}
            {party.phone && <p>{party.phone}</p>}
            {party.website && (
              <p>
                <a href={party.website} target="_blank" rel="noreferrer">
                  Website
                </a>
              </p>
            )}
            {!party.email && !party.phone && <p className="muted">No contact details yet.</p>}
            <p className="muted small">
              Profile edits update the shared directory. Account-specific contact snapshots are reviewed
              during a management handoff.
            </p>
          </section>
          <section className="card">
            <h2>Relationship notes</h2>
            <p style={{ whiteSpace: 'pre-wrap' }}>{party.notes || 'No notes yet.'}</p>
          </section>
        </aside>
      </div>
      {editing && (
        <PartyForm
          party={party}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void resource.refetch();
          }}
        />
      )}
      {linking && (
        <RelationshipLinkForm
          partyId={id}
          onClose={() => setLinking(false)}
          onSaved={() => {
            setLinking(false);
            void resource.refetch();
          }}
        />
      )}
      {affiliation && (
        <AffiliationForm
          party={party}
          parties={parties}
          existing={affiliation === 'new' ? undefined : affiliation}
          onClose={() => setAffiliation(null)}
          onSaved={() => {
            setAffiliation(null);
            void resource.refetch();
          }}
        />
      )}
    </>
  );
}
function AffiliationForm({
  party,
  parties,
  existing,
  onClose,
  onSaved,
}: {
  party: PartyRecord;
  parties: PartyRecord[];
  existing?: AffiliationRecord;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [related, setRelated] = useState(
      existing ? (party.kind === 'PERSON' ? existing.organizationId : existing.personId) : '',
    ),
    [title, setTitle] = useState(existing?.title ?? ''),
    [from, setFrom] = useState(existing?.validFrom ?? ''),
    [until, setUntil] = useState(existing?.validUntil ?? ''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const mounted = useMounted();
  const pending = useRef(false),
    requestId = useRef(crypto.randomUUID());
  function changed() {
    requestId.current = crypto.randomUUID();
  }
  return (
    <Modal
      title={existing ? 'Edit affiliation' : 'Add affiliation'}
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
              'relationshipSaveAffiliation',
              {
                id: existing?.id,
                revision: existing?.revision ?? 0,
                personId: party.kind === 'PERSON' ? party.id : related,
                organizationId: party.kind === 'ORGANIZATION' ? party.id : related,
                title,
                validFrom: from || null,
                validUntil: until || null,
                requestId: requestId.current,
              },
              true,
            );
            if (mounted.current) onSaved();
          } catch (e) {
            if (mounted.current) setError(e instanceof Error ? e.message : 'Could not save affiliation.');
          } finally {
            pending.current = false;
            if (mounted.current) setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy} className="relationship-fields">
          <label className="field">
            {party.kind === 'PERSON' ? 'Organization' : 'Person'}
            <select
              required
              disabled={!!existing}
              value={related}
              onChange={(e) => {
                setRelated(e.target.value);
                changed();
              }}
            >
              <option value="">Choose a profile</option>
              {parties
                .filter(
                  (p) => p.id !== party.id && p.kind !== party.kind && (!p.archived || p.id === related),
                )
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="field">
            Role / title
            <input
              value={title}
              maxLength={200}
              onChange={(e) => {
                setTitle(e.target.value);
                changed();
              }}
            />
          </label>
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
            First day no longer affiliated (optional)
            <input
              type="date"
              value={until}
              onChange={(e) => {
                setUntil(e.target.value);
                changed();
              }}
            />
          </label>
          <button className="primary">{busy ? 'Saving…' : 'Save affiliation'}</button>
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
