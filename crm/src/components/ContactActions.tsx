import { Button } from "./ui/Button";
import { useEffect, useRef, useState } from "react";
import { emailAction, phoneActions } from "../lib/contactActions";
import "./ContactActions.css";

export default function ContactActions({ kind, value, display, contactName }: {
  kind: "email" | "phone";
  value?: string | null;
  display?: string;
  contactName?: string | null;
}) {
  const [feedback, setFeedback] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const copyAttempt = useRef(0);
  const currentValue = useRef(value);
  currentValue.current = value;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; clearTimeout(timer.current); }; }, []);
  useEffect(() => { setFeedback(""); clearTimeout(timer.current); }, [value]);
  const raw = value?.trim();
  if (!raw) return <span>—</span>;
  const phone = kind === "phone" ? phoneActions(raw) : null;
  const href = kind === "email" ? emailAction(raw) : phone?.tel;
  const person = contactName?.trim() || raw;
  const label = kind === "email" ? "email address" : "phone number";

  async function copy() {
    const attempt = ++copyAttempt.current;
    let message: string;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(raw!);
      message = "Copied";
    } catch { message = "Select and copy the text"; }
    if (!mounted.current || attempt !== copyAttempt.current || currentValue.current?.trim() !== raw) return;
    setFeedback(message);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setFeedback(""), 2200);
  }

  return <span className="contact-actions" onClick={event => event.stopPropagation()}>
    {href ? <a className="contact-actions-value" href={href} aria-label={`${kind === "email" ? "Email" : "Call"} ${person}`} title={kind === "email" ? "Open in your email app" : "Open in your phone app"}>{display || raw}</a> : <span className="contact-actions-value">{display || raw}</span>}
    <span className="contact-actions-tools">
      {phone?.dialpad && <a href={phone.dialpad} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" aria-label={`Open ${person}'s number in Dialpad`} title="Open Dialpad to review and place the call">Dialpad ↗</a>}
      <Button variant="link" type="button"  aria-label={`Copy ${person}'s ${label}`} onClick={() => void copy()}>Copy</Button>
    </span>
    <span className="contact-actions-feedback" role="status" aria-live="polite">{feedback}</span>
  </span>;
}
