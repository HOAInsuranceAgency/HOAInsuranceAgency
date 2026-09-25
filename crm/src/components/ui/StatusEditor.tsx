import { useState } from "react";
import { Field } from "./kit";
import { useDirtyForm } from "./unsaved";

/** Selecting a value is a draft; a mutation only happens after Save. */
export function StatusEditor<T extends string>({ value, options, label, onSave }: { value: T; options: readonly T[]; label: string; onSave: (value: T) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const clearDirty = useDirtyForm(editing && draft !== value);
  if (!editing) return <button className="link" onClick={() => { setDraft(value); setEditing(true); }}>Change status<span className="sr-only"> for {label}</span></button>;
  return <div className="status-editor"><Field><label>{label} status</label><select disabled={busy} value={draft} onChange={e => setDraft(e.target.value as T)}>{options.map(option => <option key={option} value={option}>{option.replaceAll("_", " ").toLowerCase().replace(/^./, c => c.toUpperCase())}</option>)}</select></Field><div className="summary-actions"><button disabled={busy || draft === value} onClick={async () => { setBusy(true); try { if (await onSave(draft)) { clearDirty(); setEditing(false); } } finally { setBusy(false); } }}>{busy ? "Saving…" : "Save status"}</button><button className="secondary" disabled={busy} onClick={() => { clearDirty(); setEditing(false); }}>Cancel</button></div></div>;
}
