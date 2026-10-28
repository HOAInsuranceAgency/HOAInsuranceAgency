import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { client, listAllPages, type Contact } from '../lib/client';
import { useAsyncResource } from '../lib/useAsyncResource';
import { relationshipCurrent } from '../../../shared/relationships';
import PartyForm from './PartyForm';

/** Reviewed migration: never infer a company, merge shared mailboxes, or fabricate dates. */
export default function LegacyManagerReview() {
  const resource = useAsyncResource(
    async () => {
      const [contacts, accounts] = await Promise.all([
        listAllPages((nextToken) =>
          client.models.Contact.list({ filter: { type: { eq: 'MANAGER' } }, nextToken }),
        ),
        listAllPages((nextToken) => client.models.Account.list({ nextToken, selectionSet: ['id', 'name'] })),
      ]);
      const names = new Map(accounts.map((a) => [a.id, a.name]));
      return contacts
        .filter((c) => !c.partyId && relationshipCurrent(c) && names.has(c.accountId))
        .map((c) => ({ contact: c, accountName: names.get(c.accountId)! }));
    },
    [],
    { initialData: [] },
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
      {resource.error ? (
        <p role="alert" className="error-text">
          {resource.error} <button className="secondary" onClick={() => void resource.refetch()}>Retry</button>
        </p>
      ) : resource.loading ? (
        <p>Loading contacts…</p>
      ) : !resource.data.length ? (
        <p>No unlinked current manager contacts found.</p>
      ) : (
        <ul className="relationship-list">
          {resource.data.map(({ contact, accountName }) => (
            <li key={contact.id}>
              <strong>{contact.name}</strong>
              {contact.email && ` · ${contact.email}`}
              <p>
                <Link to={`/accounts/${contact.accountId}`}>{accountName}</Link>
              </p>
              <div className="toolbar">
                <button className="secondary" onClick={() => setSelected(contact)}>Create reviewed profile</button>
                <Link to={`/accounts/${contact.accountId}?management=1`}>Link an existing manager</Link>
              </div>
            </li>
          ))}
        </ul>
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
