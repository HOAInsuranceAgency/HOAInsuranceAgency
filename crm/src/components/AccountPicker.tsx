import { useState } from 'react';
import { communicationRequest } from '../lib/communications';
import { usePagedList, type Page } from '../lib/usePagedList';
export default function AccountPicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (id: string) => void;
  disabled: boolean;
}) {
  const [text, setText] = useState(''),
    [query, setQuery] = useState('');
  const [selected, setSelected] = useState<{ id: string; name: string }>();
  const page = usePagedList(
    (token) =>
      communicationRequest<Page<{ id: string; name: string }>>('searchAccounts', { query, nextToken: token }),
    [query],
    !!query,
  );
  const items = [...new Map([...page.items, ...(selected ? [selected] : [])].map((r) => [r.id, r])).values()];
  return (
    <div>
      <label className="field">
        Find insured account
        <div className="toolbar">
          <input
            value={text}
            maxLength={200}
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
            Search accounts
          </button>
        </div>
      </label>
      <label className="field">
        Insured account
        <select
          value={value}
          required
          disabled={disabled}
          onChange={(e) => {
            setSelected(items.find((r) => r.id === e.target.value));
            onChange(e.target.value);
          }}
        >
          <option value="">Choose an account</option>
          {items.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      {query && !page.items.length && !page.loading && (
        <p className="muted small">
          {page.nextToken ? 'More accounts remain to search.' : 'No matching accounts.'}
        </p>
      )}
      {page.loading && <p>Searching…</p>}
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
          Continue searching accounts
        </button>
      )}
    </div>
  );
}
