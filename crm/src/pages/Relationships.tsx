import LegacyManagerReview from '../components/LegacyManagerReview';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { loadParties } from '../lib/relationships';
import { useAsyncResource } from '../lib/useAsyncResource';
import PartyForm from '../components/PartyForm';
import './Relationships.css';
export default function Relationships() {
  const resource = useAsyncResource(loadParties, [], {
    initialData: [],
    errorMessage: 'Could not load relationships.',
  });
  const [query, setQuery] = useState(''),
    [kind, setKind] = useState(''),
    [archived, setArchived] = useState(false),
    [adding, setAdding] = useState(false);
  const navigate = useNavigate();
  const [reviewing, setReviewing] = useState(false);
  const items = resource.data
    .filter(
      (p) =>
        (archived || !p.archived) &&
        (!kind || p.kind === kind) &&
        [p.name, p.email, p.phone, p.category].some((v) => v?.toLowerCase().includes(query.toLowerCase())),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      <div className="relationship-heading">
        <div>
          <h1>Relationships</h1>
          <p className="muted">
            People and organizations you work with, whether or not they have insurance with us.
          </p>
        </div>
        <button className="primary" onClick={() => setAdding(true)}>
          + New relationship
        </button>
      </div>
      <div className="toolbar relationship-toolbar">
        <label className="field">
          Find a relationship
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name, email, phone or category"
          />
        </label>
        <label className="field">
          Type
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">All</option>
            <option value="ORGANIZATION">Organizations</option>
            <option value="PERSON">People</option>
          </select>
        </label>
        <label>
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Include
          archived
        </label>
        <button className="secondary" disabled={resource.loading} onClick={() => void resource.refetch()}>
          Refresh
        </button>
      </div>
      <div className="card">
        {resource.error ? (
          <p role="alert" className="error-text">
            {resource.error}
          </p>
        ) : resource.loading ? (
          <p>Loading relationships…</p>
        ) : !items.length ? (
          <p>No relationships found. Add a company or person to get started.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type / category</th>
                  <th>Email</th>
                  <th>Phone</th>
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link to={`/relationships/${p.id}`}>{p.name}</Link>
                      {p.archived && <span className="badge gray">Archived</span>}
                    </td>
                    <td>
                      {p.kind === 'PERSON' ? 'Person' : 'Organization'}
                      {p.category && <div className="muted small">{p.category}</div>}
                    </td>
                    <td>{p.email || '—'}</td>
                    <td>{p.phone || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p>
        <button className="link" onClick={() => setReviewing((v) => !v)}>
          {reviewing ? 'Hide manager review' : 'Review existing manager contacts'}
        </button>
      </p>
      {reviewing && <LegacyManagerReview />}
      {adding && (
        <PartyForm onClose={() => setAdding(false)} onSaved={(p) => navigate(`/relationships/${p.id}`)} />
      )}
    </>
  );
}
