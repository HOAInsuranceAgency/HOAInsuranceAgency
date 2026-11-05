import { Input } from "./ui/Input";
import { Button } from "./ui/Button";
import { Select } from "./ui/Select";
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
          <Input
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
          <Button variant="secondary"
            type="button"

            disabled={disabled || !text.trim() || page.loading}
            onClick={() => {
              if (query === text.trim()) void page.reload();
              else setQuery(text.trim());
            }}
          >
            Search accounts
          </Button>
        </div>
      </label>
      <label className="field">
        Insured account
        <Select
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
        </Select>
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
          <Button type="button" onClick={() => void page.more()}>
            Retry
          </Button>
        </p>
      )}
      {page.nextToken && (
        <Button variant="secondary"
          type="button"

          disabled={disabled || page.loading}
          onClick={() => void page.more()}
        >
          Continue searching accounts
        </Button>
      )}
    </div>
  );
}
