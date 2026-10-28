import LegacyManagerReview from '../components/LegacyManagerReview';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { searchParties } from '../lib/relationships';
import { usePagedList } from '../lib/usePagedList';
import PartyForm from '../components/PartyForm';
import './Relationships.css';
export default function Relationships() {
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  function setQuery(value: string) {
    setParams(
      (old) => {
        const next = new URLSearchParams(old);
        if (value) next.set('q', value);
        else next.delete('q');
        return next;
      },
      { replace: true },
    );
  }
  const [kind, setKind] = useState(''),
    [archived, setArchived] = useState(false),
    [adding, setAdding] = useState(false);
  const navigate = useNavigate();
  const [reviewing, setReviewing] = useState(false);
  const resource = usePagedList(
    (token) => searchParties(query, { kind, archived }, token),
    [query, kind, archived],
  );
  const items = [...resource.items].sort((a, b) => a.name.localeCompare(b.name));
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
        <button className="secondary" disabled={resource.loading} onClick={() => void resource.reload()}>
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
          <p>
            {resource.nextToken
              ? 'More profiles remain to search.'
              : 'No relationships found. Add a company or person to get started.'}
          </p>
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
      {resource.nextToken && (
        <button className="secondary" disabled={resource.loading} onClick={() => void resource.more()}>
          Load more relationships
        </button>
      )}
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
