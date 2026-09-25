import { Children, cloneElement, isValidElement, useId, useState, type HTMLAttributes, type ReactElement, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useDirtyForms } from "./unsaved";

/** Legacy field markup can use the same label/ID contract as new forms. */
export function Field({ children, className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  const generated = useId();
  const parts = Children.toArray(children);
  const label = parts.find(c => isValidElement(c) && c.type === "label") as ReactElement<{ htmlFor?: string; id?: string; children?: ReactNode }> | undefined;
  const control = parts.find(c => isValidElement(c) && (typeof c.type !== "string" || ["input", "select", "textarea"].includes(c.type))) as ReactElement<{ id?: string }> | undefined;
  const id = control?.props.id || label?.props.htmlFor || generated;
  if (label && !control) return <div {...props} role="group" aria-labelledby={id} className={`field ${className}`.trim()}>{parts.map(c => c === label ? <span key="label" id={id}>{label.props.children}</span> : c)}</div>;
  return <div {...props} className={`field ${className}`.trim()}>{parts.map(c => c === label ? cloneElement(label!, { htmlFor: id, id: `${id}-label` }) : c === control ? cloneElement(control!, { id }) : c)}</div>;
}

export function SectionNav<T extends string>({ label, items, value, onChange }: { label: string; items: readonly (readonly [T, string])[]; value: T; onChange: (value: T) => void }) {
  return <div className="section-nav">
    <nav className="tabs section-nav-desktop" aria-label={label}>{items.map(([key, title]) => <button key={key} type="button" aria-current={value === key ? "page" : undefined} className={value === key ? "active" : ""} onClick={() => onChange(key)}>{title}</button>)}</nav>
    <label className="section-nav-mobile">{label}<select value={value} onChange={e => onChange(e.target.value as T)}>{items.map(([key, title]) => <option key={key} value={key}>{title}</option>)}</select></label>
  </div>;
}

/** Unmount closed editors so a summary does not load every form on a record. */
export function Disclosure({ title, description, children, initiallyOpen = false }: { title: string; description?: string; children: ReactNode; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const id = useId();
  const { confirmDiscard } = useDirtyForms();
  return <section className="card disclosure">
    <button type="button" className="disclosure-heading" aria-expanded={open} aria-controls={id} onClick={() => { if (!open || confirmDiscard()) setOpen(!open); }}><span><strong>{title}</strong>{description && <small>{description}</small>}</span><span aria-hidden="true">{open ? "−" : "+"}</span></button>
    {open && <div id={id} className="disclosure-body">{children}</div>}
  </section>;
}

export function Pagination({ total, page, onPage, size = 25, noun = "items" }: { total: number; page: number; onPage: (page: number) => void; size?: number; noun?: string }) {
  const last = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(page, 1), last);
  return <nav className="pagination" aria-label={`${noun} pages`}><span role="status">{total ? `${(current - 1) * size + 1}–${Math.min(current * size, total)} of ${total} ${noun}` : `No ${noun}`}</span>{last > 1 && <div><button type="button" className="secondary" disabled={current === 1} onClick={() => onPage(current - 1)}>Previous</button><span>Page {current} of {last}</span><button type="button" className="secondary" disabled={current === last} onClick={() => onPage(current + 1)}>Next</button></div>}</nav>;
}

export function Breadcrumb({ to, children }: { to: string; children: ReactNode }) {
  return <nav className="breadcrumbs" aria-label="Breadcrumb"><Link to={to}>← {children}</Link></nav>;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty-state"><strong>{title}</strong>{children && <p>{children}</p>}</div>;
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return <div className="loading-state" role="status"><span>{label}</span><div className="skeleton" /><div className="skeleton" /></div>;
}
