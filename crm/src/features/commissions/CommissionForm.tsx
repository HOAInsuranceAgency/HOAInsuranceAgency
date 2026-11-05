import { useContext, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { useLiveUpdateBlock } from "../../lib/useLiveUpdates";
import { FinancialStale } from './context';

export function ActionForm({
  title,
  submit,
  children,
  onDone,
  button = 'Save',
  disabled = false,
  draft,
}: {
  title: string;
  submit: () => Promise<unknown>;
  children: ReactNode;
  // A callback that resets visible fields must return that acknowledged draft.
  // Otherwise keep the submitted baseline, preserving edits made while saving.
  onDone: () => Promise<void | { savedDraft: unknown }>;
  button?: string;
  disabled?: boolean;
  draft?: unknown;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState(false);
  const lock = useRef(false);
  const stale = useContext(FinancialStale);
  const serialized = JSON.stringify(draft);
  const baseline = useRef(serialized);
  useLiveUpdateBlock(busy || serialized !== baseline.current);
  async function run(e: FormEvent) {
    e.preventDefault();
    if (lock.current || stale) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setSaved(false);
    const submitted = serialized;
    try {
      await submit();
      const completed = await onDone();
      baseline.current = completed ? JSON.stringify(completed.savedDraft) : submitted;
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <form className="card" onSubmit={(e) => void run(e)}>
      <h2>{title}</h2>
      <fieldset disabled={busy || stale}>
        {children}
        <div className="form-actions">
          <Button variant="primary" type="submit" disabled={disabled}>
            {busy ? 'Saving…' : button}
          </Button>
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {saved && <p role="status">Saved.</p>}
    </form>
  );
}

export function Field({
  label,
  value,
  change,
  type = 'text',
}: {
  label: string;
  value: string;
  change: (v: string) => void;
  type?: string;
}) {
  return (
    <label className="field">
      {label}
      <Input required type={type} value={value} onChange={(e) => change(e.target.value)} />
    </label>
  );
}
