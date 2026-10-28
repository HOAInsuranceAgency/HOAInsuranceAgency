import { useId, useState } from 'react';
import { searchParties, type PartyRecord } from '../lib/relationships';
import { usePagedList } from '../lib/usePagedList';
export default function PartyPicker({
  label,
  value,
  onChange,
  initial = [],
  emptyLabel = 'Choose a relationship',
  kind,
  required = false,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (id: string, party?: PartyRecord) => void;
  initial?: PartyRecord[];
  emptyLabel?: string;
  kind?: string;
  required?: boolean;
  disabled?: boolean;
}) {
  const id = useId();
  const [text, setText] = useState(''),
    [query, setQuery] = useState(''),
    [selected, setSelected] = useState<PartyRecord>();
  const page = usePagedList((token) => searchParties(query, { kind }, token), [query, kind], !!query);
  const items = [
    ...new Map(
      [...initial, ...page.items, ...(selected ? [selected] : [])]
        .filter((p) => !p.archived && (!kind || p.kind === kind))
        .map((p) => [p.id, p]),
    ).values(),
  ];
  return (
    <div className="relationship-picker">
      <label className="field" htmlFor={`${id}-search`}>
        Find {label.toLowerCase()}
        <div className="toolbar">
          <input
            id={`${id}-search`}
            value={text}
            maxLength={200}
            disabled={disabled}
            placeholder="Name, email, phone or category"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                setQuery(text.trim());
              }
            }}
          />
          <button
            type="button"
            className="secondary"
            disabled={disabled || !text.trim() || page.loading}
            onClick={() => {
              if (query === text.trim()) void page.reload();
              else setQuery(text.trim());
            }}
          >
            Search
          </button>
        </div>
      </label>
      <label className="field" htmlFor={`${id}-select`}>
        {label}
        <select
          id={`${id}-select`}
          value={value}
          required={required}
          disabled={disabled}
          onChange={(e) => {
            const party = items.find((p) => p.id === e.target.value);
            setSelected(party);
            onChange(e.target.value, party);
          }}
        >
          <option value="">{emptyLabel}</option>
          {value && !items.some((p) => p.id === value) && (
            <option value={value}>Selected relationship</option>
          )}
          {items.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.email ? ` · ${p.email}` : ''}
            </option>
          ))}
        </select>
      </label>
      {page.loading && <p className="muted small">Searching…</p>}
      {query && !page.loading && !page.items.length && (
        <p className="muted small">
          {page.nextToken ? 'More profiles remain to search.' : 'No matching profiles.'}
        </p>
      )}
      {page.error && (
        <p role="alert" className="error-text">
          {page.error}{' '}
          <button type="button" onClick={() => void page.more()}>
            Retry
          </button>
        </p>
      )}
      {page.nextToken && (
        <button
          type="button"
          className="secondary"
          disabled={disabled || page.loading}
          onClick={() => void page.more()}
        >
          Continue searching
        </button>
      )}
    </div>
  );
}
