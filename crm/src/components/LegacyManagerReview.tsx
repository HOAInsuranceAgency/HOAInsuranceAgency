import { Button } from "./ui/Button";
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Contact } from '../lib/client';
import { communicationRequest } from '../lib/communications';
import { usePagedList } from '../lib/usePagedList';
import PartyForm from './PartyForm';
/** Each page is filtered and authorized on the server, with batched account names. */
export default function LegacyManagerReview() {
  const resource = usePagedList(
    (nextToken) => communicationRequest('relationshipLegacyCandidates', { nextToken }),
    [],
  );
  const [selected, setSelected] = useState<Contact | null>(null);
  const navigate = useNavigate();
  return (
    <section className="card">
      <h2>Review existing manager contacts</h2>
      <p className="muted small">
        These contacts belong to accounts you can access. Review each person and company before adding them to
        the shared directory. No data is copied automatically.
      </p>
      {resource.error && (
        <p role="alert" className="error-text">
          {resource.error}{' '}
          <Button variant="secondary"  onClick={() => void resource.more()}>
            Retry
          </Button>
        </p>
      )}
      {resource.loading && <p>Loading contacts…</p>}
      {!resource.loading && !resource.items.length && (
        <p>
          {resource.nextToken
            ? 'More contacts remain to review. Continue to the next page.'
            : 'No unlinked current manager contacts found.'}
        </p>
      )}
      <ul className="relationship-list">
        {resource.items.map(({ contact, accountName }) => (
          <li key={contact.id}>
            <strong>{contact.name}</strong>
            {contact.email && ` · ${contact.email}`}
            <p>
              <Link to={`/accounts/${contact.accountId}`}>{accountName}</Link>
            </p>
            <div className="toolbar">
              <Button variant="secondary"  onClick={() => setSelected(contact)}>
                Create reviewed profile
              </Button>
              <Link to={`/accounts/${contact.accountId}?management=1`}>Link an existing manager</Link>
            </div>
          </li>
        ))}
      </ul>
      {resource.nextToken && (
        <Button variant="secondary"  disabled={resource.loading} onClick={() => void resource.more()}>
          Load more contacts
        </Button>
      )}
      {selected && (
        <PartyForm
          initial={{
            kind: 'PERSON',
            name: selected.name,
            email: selected.email,
            phone: selected.phone,
            category: 'Property management',
          }}
          onClose={() => setSelected(null)}
          onSaved={(p) =>
            navigate(`/accounts/${selected.accountId}?management=1&partyId=${encodeURIComponent(p.id)}`)
          }
        />
      )}
    </section>
  );
}
