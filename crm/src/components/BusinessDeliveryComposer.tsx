import { Input } from "./ui/Input";
import { Button } from "./ui/Button";
import { Select } from "./ui/Select";
import { useEffect, useId, useRef, useState } from "react";
import type { BusinessDeliveryAttempt, BusinessDeliveryContext, BusinessDeliveryKind, BusinessDeliveryPreview, PrepareBusinessDraftInput, PublicProposalQuote } from "../../../shared/frontBusinessDelivery";
import { isBusinessDeliveryFile } from "../../../shared/frontBusinessDelivery";
import { communicationRequest as request } from "../lib/communications";
import { fmtDate, fmtDateTime, fmtMoney, friendlyError } from "../lib/client";
import { isAuthorizationError } from "../lib/authorizationError";
import { useAsyncResource } from "../lib/useAsyncResource";
import Modal from "./Modal";
import "./BusinessDeliveryComposer.css";

export interface BusinessDeliveryComposerProps {
  accountId: string;
  conversationId?: string;
  kind?: BusinessDeliveryKind;
  recordId?: string;
  onClose: () => void;
}
type History = { items: BusinessDeliveryAttempt[]; nextToken?: string };
const KIND_LABELS: Record<BusinessDeliveryKind, string> = { PACKAGE: "Proposal package", CERTIFICATE: "Certificate", DOCUMENT: "Document" };
const STATE_LABELS = { PREPARING: "Preparing", DRAFT: "Prepared", UNKNOWN: "Needs review", FAILED: "Failed", SENT: "Sent" };

function mergeAttemptEvidence(previous: BusinessDeliveryAttempt | undefined, incoming: BusinessDeliveryAttempt): BusinessDeliveryAttempt {
  if (!previous) return incoming;
  const stale = previous.state === "FAILED" && incoming.state !== "FAILED" || previous.state === "SENT" && !["SENT", "FAILED"].includes(incoming.state);
  const current = stale ? previous : incoming;
  return { ...current,
    sentWithChanges: previous.sentWithChanges || incoming.sentWithChanges ? true : current.sentWithChanges,
    sentAt: current.sentAt ?? previous.sentAt ?? incoming.sentAt,
    reference: current.reference ?? previous.reference ?? incoming.reference,
    frontDraftId: current.frontDraftId ?? previous.frontDraftId ?? incoming.frontDraftId,
    frontUrl: current.frontUrl ?? previous.frontUrl ?? incoming.frontUrl,
    messageUrl: current.messageUrl ?? previous.messageUrl ?? incoming.messageUrl,
  };
}

export function safeFrontUrl(value?: string): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.hostname === "app.frontapp.com" && !url.port && !url.username && !url.password && !url.search && !url.hash && /^\/open\/(?:cnv|msg)_[a-z0-9]+$/.test(url.pathname)) return url.href;
  } catch { /* Invalid provider links never become clickable. */ }
}

export function recoveryFrontMessageId(value: string): string {
  const text = value.trim();
  if (/^msg_[a-z0-9]+$/.test(text)) return text;
  const url = safeFrontUrl(text);
  const messageId = url && new URL(url).pathname.match(/^\/open\/(msg_[a-z0-9]+)$/)?.[1];
  if (messageId) return messageId;
  throw new Error("Enter the exact msg_ message ID or its Front message link. A conversation link alone cannot identify the draft.");
}

export function businessRecipients(toText: string, ccText: string): { to: string[]; cc: string[] } {
  const parse = (text: string) => text.split(/[,;\n]/).map(value => value.trim()).filter(Boolean);
  const to = parse(toText), cc = parse(ccText), all = [...to, ...cc];
  if (!to.length) throw new Error("Enter at least one To email address.");
  if (all.length > 20) throw new Error("Choose no more than 20 To and CC recipients combined.");
  if (all.some(value => value.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value))) throw new Error("Enter email addresses separated by commas; leave out display names.");
  if (new Set(all.map(value => value.toLowerCase())).size !== all.length) throw new Error("Each email address can appear only once across To and CC.");
  return { to, cc };
}

function plainBody(html: string): string {
  return new DOMParser().parseFromString(html.replace(/<br\s*\/?\s*>|<\/(?:p|h[1-6]|li)>/gi, "\n"), "text/html").body.textContent?.trim() ?? "";
}

const TERMS = [
  ["perOccurrenceDeductible", "Per-occurrence deductible", "money"], ["perUnitDeductible", "Per-unit deductible", "money"],
  ["blanketLimit", "Blanket limit", "money"], ["coinsurancePct", "Coinsurance", "percent"], ["replacementCostType", "Replacement cost", "text"],
  ["glEachOccurrence", "GL each occurrence", "money"], ["glDamageToRentedPremises", "Damage to rented premises", "money"],
  ["glMedicalExpense", "Medical expense", "money"], ["glPersonalAdvInjury", "Personal / advertising injury", "money"],
  ["glGeneralAggregate", "General aggregate", "money"], ["glProductsCompletedOps", "Products / completed operations", "money"],
  ["glAggregateAppliesTo", "Aggregate applies to", "text"], ["minimumEarnedPremiumPct", "Minimum earned premium", "percent"],
] as const;

function ProposalTerms({ quote }: { quote: PublicProposalQuote }) {
  return <details className="business-delivery-terms" open><summary>{quote.carrierName} · {quote.lines.join(", ")} · {fmtMoney(quote.premium)}</summary>
    <dl><div><dt>Policy term</dt><dd>{fmtDate(quote.effectiveDate)} – {fmtDate(quote.expirationDate)}</dd></div>
      <div><dt>Offer valid through</dt><dd>{quote.offerExpiresAt ? fmtDate(quote.offerExpiresAt) : "Not recorded"}</dd></div>
      {TERMS.map(([key, label, format]) => quote[key] == null ? null : <div key={key}><dt>{label}</dt><dd>{format === "money" ? fmtMoney(quote[key] as number) : format === "percent" ? `${quote[key]}%` : String(quote[key])}</dd></div>)}
      {quote.glClaimsMade != null && <div><dt>GL form</dt><dd>{quote.glClaimsMade ? "Claims-made" : "Occurrence"}</dd></div>}
    </dl>
  </details>;
}

export default function BusinessDeliveryComposer(props: BusinessDeliveryComposerProps) {
  return <BusinessDeliveryComposerContent key={`${props.accountId}:${props.conversationId ?? ""}:${props.kind ?? ""}:${props.recordId ?? ""}`} {...props} />;
}

function BusinessDeliveryComposerContent({ accountId, conversationId, kind, recordId, onClose }: BusinessDeliveryComposerProps) {
  const id = useId();
  const evidence = useRef(new Map<string, BusinessDeliveryAttempt>());
  function rememberAttempt(incoming: BusinessDeliveryAttempt) {
    const current = mergeAttemptEvidence(evidence.current.get(incoming.id), incoming);
    evidence.current.set(current.id, current);
    return current;
  }
  const context = useAsyncResource(() => request<{ context: BusinessDeliveryContext }>("businessDeliveryContext", { accountId }), [accountId], { initialData: null, errorMessage: "Could not load delivery choices" });
  const history = useAsyncResource(async () => {
    try { const page = await request<History>("historyBusinessDeliveries", { accountId }); return { ...page, items: page.items.map(rememberAttempt) }; }
    catch (err) { if (isAuthorizationError(err)) context.invalidate(err); throw err; }
  }, [accountId], { initialData: { items: [] } as History, errorMessage: "Could not load Front draft history" });
  const [choiceKey, setChoiceKey] = useState(kind && recordId ? `${kind}:${recordId}` : "");
  const [thread, setThread] = useState(conversationId ?? "NEW");
  const [documentIds, setDocumentIds] = useState<string[]>([]);
  const [to, setTo] = useState(""), [cc, setCc] = useState("");
  const [preview, setPreview] = useState<BusinessDeliveryPreview | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [attempt, setAttempt] = useState<BusinessDeliveryAttempt | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [recoveryValues, setRecoveryValues] = useState<Record<string, string>>({});
  const [recoveryErrors, setRecoveryErrors] = useState<Record<string, string>>({});
  const flight = useRef(false), mounted = useRef(true), lastInput = useRef<PrepareBusinessDraftInput | null>(null);
  const [, updateExpiry] = useState(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!preview) return;
    const timer = window.setTimeout(() => updateExpiry(value => value + 1), Math.max(0, Date.parse(preview.expiresAt) - Date.now() + 1));
    return () => window.clearTimeout(timer);
  }, [preview]);
  useEffect(() => {
    if (!uncertain || !lastInput.current) return;
    const found = history.data.items.find(item => item.requestId === lastInput.current?.requestId);
    if (found) { setAttempt(found); setUncertain(false); }
  }, [history.data, uncertain]);
  useEffect(() => {
    if (!attempt) return;
    const found = history.data.items.find(item => item.id === attempt.id);
    // Account-index reads can lag a direct prepare/reconcile response. Accept
    // verified terminal progress without reviving a stale draft or failed send.
    if (found && (found.state === "FAILED" && attempt.state !== "FAILED" || found.state === "SENT" && !["SENT", "FAILED"].includes(attempt.state) || found.sentWithChanges && !attempt.sentWithChanges)) setAttempt(found);
  }, [history.data, attempt]);
  useEffect(() => {
    if (context.loaded && !context.data) { setPreview(null); setAttempt(null); setTo(""); setCc(""); lastInput.current = null; setUncertain(false); evidence.current.clear(); }
  }, [context.loaded, context.data]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible" && !flight.current) void history.refetch(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [history.refetch]);

  const data = context.data?.context;
  const choice = data?.choices.find(item => `${item.kind}:${item.recordId}` === choiceKey);
  const packageDocuments = data?.documents.filter(document => isBusinessDeliveryFile(document, true)) ?? [];
  const validThread = thread === "NEW" || !!data?.conversations.some(item => item.id === thread);
  const pending = choice && history.data.items.find(item => item.kind === choice.kind && item.recordId === choice.recordId && ["PREPARING", "UNKNOWN"].includes(item.state));
  const frozen = !!busy || uncertain || !!attempt;
  const expired = !!preview && (!Number.isFinite(Date.parse(preview.expiresAt)) || Date.parse(preview.expiresAt) <= Date.now());
  const invalidatePreview = () => { setPreview(null); setReviewed(false); setError(""); lastInput.current = null; };
  const reportError = (err: unknown, fallback: string) => {
    setError(friendlyError(err, fallback));
    if (isAuthorizationError(err)) { context.invalidate(err); history.invalidate(err); setPreview(null); setAttempt(null); setTo(""); setCc(""); lastInput.current = null; setUncertain(false); evidence.current.clear(); }
  };

  async function showPreview() {
    if (flight.current || !choice || choice.disabledReason || !data?.sender || !validThread) return;
    flight.current = true; setBusy("Preparing preview…"); setError(""); setReviewed(false);
    try {
      const result = await request<{ preview: BusinessDeliveryPreview }>("previewBusinessDelivery", { accountId, kind: choice.kind, recordId: choice.recordId, conversationId: thread, documentIds }, true);
      if (mounted.current) { setPreview(result.preview); lastInput.current = null; }
    } catch (err) { if (mounted.current) reportError(err, "Could not prepare the preview"); }
    finally { flight.current = false; if (mounted.current) setBusy(""); }
  }

  async function createDraft(retry?: PrepareBusinessDraftInput) {
    if (flight.current) return;
    let input = retry;
    if (!input) {
      if (!preview || expired || !reviewed || pending || history.loading || history.error) return;
      try { input = { accountId, previewId: preview.previewId, previewHash: preview.previewHash, requestId: crypto.randomUUID(), ...businessRecipients(to, cc), conversationId: preview.conversationId }; }
      catch (err) { reportError(err, "Check the recipients"); return; }
    }
    lastInput.current = input;
    flight.current = true; setBusy("Preparing Front draft…"); setError("");
    try {
      const result = await request<{ attempt: BusinessDeliveryAttempt }>("prepareBusinessDraft", input, true);
      if (!mounted.current) return;
      setAttempt(rememberAttempt(result.attempt)); setUncertain(false); void history.refetch();
    } catch (err) {
      if (mounted.current) {
        reportError(err, "Could not confirm the Front draft");
        if (err instanceof Error && (err as Error & { code?: unknown }).code === "BUSINESS_DRAFT_NOT_DISPATCHED") {
          setPreview(null); setReviewed(false); lastInput.current = null; setUncertain(false);
        } else if (!isAuthorizationError(err)) { setUncertain(true); void history.refetch(); }
      }
    } finally { flight.current = false; if (mounted.current) setBusy(""); }
  }

  async function reconcile(item: BusinessDeliveryAttempt, recoveryMessageId?: string) {
    if (flight.current) return;
    flight.current = true; setBusy("Checking Front status…"); setError("");
    try {
      const result = await request<{ attempt: BusinessDeliveryAttempt }>("reconcileBusinessDraft", { accountId, attemptId: item.id, ...(recoveryMessageId ? { recoveryMessageId } : {}) }, true);
      if (!mounted.current) return;
      const verified = rememberAttempt(result.attempt);
      history.setData(previous => ({ ...previous, items: previous.items.map(row => row.id === verified.id ? verified : row) }));
      if (recoveryMessageId || attempt?.id === item.id || lastInput.current?.requestId === item.requestId) { setAttempt(verified); setUncertain(false); }
    } catch (err) { if (mounted.current) reportError(err, "Could not check Front status"); }
    finally { flight.current = false; if (mounted.current) setBusy(""); }
  }

  function recover(item: BusinessDeliveryAttempt) {
    try {
      const messageId = recoveryFrontMessageId(recoveryValues[item.id] ?? "");
      setRecoveryErrors(values => ({ ...values, [item.id]: "" }));
      void reconcile(item, messageId);
    } catch (err) {
      setRecoveryErrors(values => ({ ...values, [item.id]: err instanceof Error ? err.message : "Check the Front message ID." }));
    }
  }

  async function loadMore() {
    if (loadingMore || !history.data.nextToken) return;
    const captured = history.data; setLoadingMore(true);
    try {
      const result = await request<History>("historyBusinessDeliveries", { accountId, nextToken: captured.nextToken });
      if (mounted.current) history.setData(previous => previous === captured ? { items: [...new Map([...previous.items, ...result.items.map(rememberAttempt)].map(item => [item.id, item])).values()], nextToken: result.nextToken } : previous);
    } catch (err) { if (mounted.current) reportError(err, "Could not load older drafts"); }
    finally { if (mounted.current) setLoadingMore(false); }
  }

  function attemptRow(item: BusinessDeliveryAttempt) {
    const url = safeFrontUrl(item.messageUrl) ?? safeFrontUrl(item.frontUrl);
    return <li key={item.id} className="business-delivery-attempt"><div><strong>{item.state === "SENT" && item.sentWithChanges ? "Sent with changes" : STATE_LABELS[item.state]}</strong> · {item.kind === "QUOTE" ? "Quote" : KIND_LABELS[item.kind]} · {fmtDateTime(item.sentAt ?? item.preparedAt)}</div>
      {item.reference && <p className="small">Email reference: <code>{item.reference}</code></p>}
      <p className="small">From {item.from} · {item.sentWithChanges ? "Originally prepared for To: " : "To "}{item.to.join(", ")}{item.cc.length ? ` · ${item.sentWithChanges ? "Originally prepared CC:" : "CC"} ${item.cc.join(", ")}` : ""}</p>
      {item.failure && <p className="error-text">{item.failure}</p>}
      {item.sentWithChanges && <p className="business-delivery-notice">The message was sent with changes in Front. Open Front to verify the actual recipients, message and attachments. The recipients above are the original preparation, and this send did not mark current quotes as presented.</p>}
      {item.state === "DRAFT" && <p className="small">Review the message and every attachment in Front, then send it there.</p>}
      {item.state === "SENT" && <p className="muted small">Sent via Front. This does not confirm receipt or reading.</p>}
      {item.state === "UNKNOWN" && <p className="small">The draft result needs review. Check Front before preparing another copy. Ask an administrator for help if the teammate who prepared it is unavailable.</p>}
      {["PREPARING", "UNKNOWN"].includes(item.state) && !item.frontDraftId && <form className="business-delivery-recovery" aria-label="Recover unconfirmed Front draft" onSubmit={event => { event.preventDefault(); recover(item); }}>
        {item.reference && <p className="small">Search Front for the email reference shown above to find this draft.</p>}
        <p className="small">Find the exact draft or sent message in Front. Check this account, sender, recipients and attachments, then paste its message ID or direct message link. The CRM will verify it before linking it to this attempt.</p>
        <label className="field" htmlFor={`${id}-recover-${item.id}`}>Front draft/message ID or message link<Input id={`${id}-recover-${item.id}`} type="text" autoComplete="off" placeholder="msg_… or https://app.frontapp.com/open/msg_…" value={recoveryValues[item.id] ?? ""} disabled={!!busy} aria-invalid={!!recoveryErrors[item.id]} onChange={event => { setRecoveryValues(values => ({ ...values, [item.id]: event.target.value })); setRecoveryErrors(values => ({ ...values, [item.id]: "" })); }} /></label>
        {recoveryErrors[item.id] && <p className="error-text" role="alert">{recoveryErrors[item.id]}</p>}
        <Button variant="secondary" type="submit"  disabled={!!busy || !recoveryValues[item.id]?.trim()}>Verify and link existing Front message</Button>
        <p className="muted small">If you cannot find it, keep this attempt in Needs review. This action does not create or send another draft.</p>
      </form>}
      <div className="toolbar">{url && <a href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Open in Front ↗</a>}
        <Button variant="link" type="button"  disabled={!!busy} onClick={() => void reconcile(item)}>Check Front status</Button></div>
    </li>;
  }

  return <Modal title="Prepare email in Front" onClose={() => { if (!busy) onClose(); }} className="business-delivery-modal">
    <div className="business-delivery-composer">
      <p><strong>{data?.accountName ?? "Account email"}</strong></p>
      <p className="muted small">Prepare a draft here, then review and send it in Front. Preparing a draft does not send email, record client approval, or bind coverage.</p>
      {busy && <p role="status" aria-live="polite">{busy}</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      {context.error && <p className="error-text" role="alert">{context.error} <Button variant="link" type="button"  disabled={!!busy || context.loading} onClick={() => void context.refetch()}>Retry choices</Button></p>}
      {context.loading && !data && <p role="status">Loading delivery choices…</p>}
      {data && !attempt && <>
        <p className="business-delivery-from"><strong>From:</strong> {preview?.sender.senderEmail ?? data.sender?.senderEmail ?? "Mailbox unavailable"}</p>
        {data.senderError && <p className="error-text" role="alert">{data.senderError}</p>}
        <label className="field" htmlFor={`${id}-choice`}>What to send<Select id={`${id}-choice`} value={choiceKey} disabled={frozen} onChange={event => { setChoiceKey(event.target.value); setDocumentIds([]); invalidatePreview(); }}>
          <option value="">Choose a proposal, certificate or document</option>
          {choiceKey && !choice && <option value={choiceKey} disabled>Selected item is unavailable</option>}
          {(["PACKAGE", "CERTIFICATE", "DOCUMENT"] as const).map(group => <optgroup key={group} label={KIND_LABELS[group]}>{data.choices.filter(item => item.kind === group).map(item => <option key={`${item.kind}:${item.recordId}`} value={`${item.kind}:${item.recordId}`} disabled={!!item.disabledReason}>{item.label}{item.disabledReason ? " — needs review" : ""}</option>)}</optgroup>)}
        </Select></label>
        {choice?.disabledReason && <p role="alert" className="error-text">{choice.disabledReason}</p>}
        {choiceKey && !choice && <p role="alert" className="error-text">This item is no longer available. Refresh its CRM record before preparing email.</p>}
        <label className="field" htmlFor={`${id}-thread`}>Front conversation<Select id={`${id}-thread`} value={thread} disabled={frozen} onChange={event => { setThread(event.target.value); invalidatePreview(); }}>
          <option value="NEW">New conversation — no quoted client history</option>
          {!validThread && <option value={thread} disabled>Selected conversation is unavailable</option>}
          {data.conversations.filter(item => item.id !== "NEW").map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </Select></label>
        <p className="muted small">An existing conversation can only use its current participants. For a new certificate holder or another recipient, choose a new conversation.</p>
        {choice?.kind === "CERTIFICATE" && <p className="business-delivery-notice">Choose the certificate holder or requester for To. Add the client in CC only when appropriate.</p>}
        <div className="business-delivery-recipients">
          <label className="field" htmlFor={`${id}-to`}>To<Input id={`${id}-to`} type="text" inputMode="email" autoComplete="off" value={to} disabled={frozen} onChange={event => { setTo(event.target.value); setReviewed(false); }} placeholder="recipient@example.com" /></label>
          <label className="field" htmlFor={`${id}-cc`}>CC (optional)<Input id={`${id}-cc`} type="text" inputMode="email" autoComplete="off" value={cc} disabled={frozen} onChange={event => { setCc(event.target.value); setReviewed(false); }} /></label>
        </div>
        <p className="muted small">Separate email addresses with commas. No recipient is added automatically.</p>
        {!!data.recipientSuggestions.length && <details><summary>Account contact suggestions</summary><ul className="business-delivery-contacts">{data.recipientSuggestions.map(contact => <li key={contact.email}><span>{contact.label} · {contact.email}</span><Button variant="link" type="button"  disabled={frozen} onClick={() => { setTo(value => value ? `${value}, ${contact.email}` : contact.email); setReviewed(false); }}>Add to To</Button><Button variant="link" type="button"  disabled={frozen} onClick={() => { setCc(value => value ? `${value}, ${contact.email}` : contact.email); setReviewed(false); }}>Add to CC</Button></li>)}</ul></details>}
        {choice?.kind === "PACKAGE" && <fieldset className="business-delivery-documents" disabled={frozen}><legend>Carrier PDFs to include</legend><p className="muted small">Choose up to 10 account PDFs. The reviewed proposal is included separately. Maximum total attachment size: 25 MB.</p>
          {packageDocuments.length ? packageDocuments.map(document => <label key={document.id}><Input type="checkbox" checked={documentIds.includes(document.id)} disabled={!documentIds.includes(document.id) && documentIds.length >= 10} onChange={event => { setDocumentIds(values => event.target.checked ? [...values, document.id] : values.filter(value => value !== document.id)); invalidatePreview(); }} /> {document.name}{document.size != null ? ` · ${Math.ceil(document.size / 1024)} KB` : ""}</label>) : <p>No eligible account PDFs. Upload carrier PDFs in the CRM Documents tab.</p>}
        </fieldset>}
        <Button variant="secondary" type="button"  disabled={frozen || !choice || !!choice.disabledReason || !data.sender || !validThread} onClick={() => void showPreview()}>{preview ? "Refresh preview" : "Review email preview"}</Button>
        {preview && <section className="business-delivery-preview" aria-label="Email preview"><h3>Email preview</h3><p><strong>Conversation:</strong> {preview.conversationLabel}</p><p><strong>Subject:</strong> {preview.subject}</p><pre>{plainBody(preview.body)}</pre>
          {preview.quotes.map(quote => <ProposalTerms key={quote.id} quote={quote} />)}
          <h4>Attachments</h4><ul>{preview.attachments.map(file => <li key={file.id}>{file.name}{file.size != null ? ` · ${Math.ceil(file.size / 1024)} KB` : ""}</li>)}</ul>
          {preview.warnings.map((warning, index) => <p className="business-delivery-notice" key={index}>{warning}</p>)}
          <p className="muted small">Preview valid until {fmtDateTime(preview.expiresAt)}. Review every attachment in Front before sending.</p>
          {expired && <p className="error-text" role="alert">This preview has expired. Refresh it before preparing the draft.</p>}
          <label className="business-delivery-confirm"><Input type="checkbox" checked={reviewed} disabled={frozen || expired} onChange={event => setReviewed(event.target.checked)} /> I checked the sender, conversation, recipients and selected documents. I will review the message and attachments in Front before sending.</label>
          {pending && <p className="business-delivery-notice">An earlier draft for this item needs review. Check its Front status below before preparing another.</p>}
          <Button variant="primary" type="button"  disabled={frozen || expired || !reviewed || !!pending || history.loading || !!history.error} onClick={() => void createDraft()}>Prepare Front draft</Button>
        </section>}
      </>}
      {uncertain && <section className="business-delivery-notice" aria-label="Unconfirmed draft"><h3>Check before trying again</h3><p>The draft result could not be confirmed. Check the history and Front first. Retrying below uses the same request and recipients.</p><Button variant="secondary" type="button"  disabled={!!busy || !lastInput.current} onClick={() => void createDraft(lastInput.current ?? undefined)}>Retry same draft request</Button> <Button variant="secondary" type="button"  disabled={!!busy || history.loading} onClick={() => void history.refetch()}>Refresh history</Button></section>}
      {attempt && <section aria-label="Prepared draft result"><ul className="business-delivery-history">{attemptRow(attempt)}</ul>{!["UNKNOWN", "PREPARING"].includes(attempt.state) && <Button variant="secondary" type="button"  disabled={!!busy} onClick={() => { setAttempt(null); invalidatePreview(); }}>Prepare another email</Button>}</section>}
      <section aria-label="Front email history" className="business-delivery-history-section"><div className="toolbar"><h3>Front email history</h3><Button variant="link" type="button"  disabled={!!busy || history.loading} onClick={() => void history.refetch()}>Refresh history</Button></div>
        <p className="muted small">Prepared means a draft exists. Sent means Front recorded an outbound message; neither confirms receipt.</p>
        {history.error && <p role="alert" className="error-text">{history.error}</p>}
        {history.loading && !history.loaded && <p role="status">Loading draft history…</p>}
        {history.loaded && !history.error && !history.data.items.length && <p className="muted small">No Front drafts recorded for this account.</p>}
        <ul className="business-delivery-history">{history.data.items.filter(item => item.id !== attempt?.id).map(attemptRow)}</ul>
        {history.data.nextToken && <Button variant="secondary" type="button"  disabled={loadingMore || !!busy || history.loading} onClick={() => void loadMore()}>{loadingMore ? "Loading older drafts…" : "Load older drafts"}</Button>}
      </section>
    </div>
  </Modal>;
}
