import { formatUsdCents as money } from '../../../shared/money';
import { useEffect, useState } from 'react';
import type { BrokerFeePublicTerms } from '../../../shared/brokerFees';
import { loadBrokerFeeDisclosure, signBrokerFeeDisclosure } from '../lib/brokerFeeDisclosure';
import './BrokerFeeDisclosure.css';

export function BrokerFeeDisclosure() {
  const [token] = useState(() => typeof window === 'undefined' ? '' : new URL(window.location.href).searchParams.get('t') || ''), [terms, setTerms] = useState<BrokerFeePublicTerms | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [retry, setRetry] = useState(0);
  const [name, setName] = useState(''), [email, setEmail] = useState(''), [role, setRole] = useState(''), [consent, setConsent] = useState(false);
  useEffect(() => { const url = new URL(window.location.href); url.searchParams.delete('t'); window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`); }, []);
  useEffect(() => {
    if (!token) return;
    let active = true; setError('');
    loadBrokerFeeDisclosure(token).then(value => { if (active) setTerms(value); }).catch(value => { if (active) setError(value instanceof Error ? value.message : 'The disclosure could not be loaded.'); });
    return () => { active = false; };
  }, [token, retry]);
  async function sign(event: React.FormEvent) {
    event.preventDefault(); if (busy || !consent) return; setBusy(true); setError('');
    try { setTerms(await signBrokerFeeDisclosure(token, { signerName: name, signerEmail: email, signerRole: role, consent })); }
    catch (value) { setError(value instanceof Error ? value.message : 'Your signature could not be saved. Please retry.'); }
    finally { setBusy(false); }
  }
  if (!token) return <div className="bfd-card"><h1>Broker fee disclosure</h1><p>Open the disclosure link from your agency's proposal email.</p></div>;
  if (!terms) return <div className="bfd-card"><h1>Broker fee disclosure</h1>{error ? <><p role="alert">{error}</p><button onClick={() => setRetry(value => value + 1)}>Retry disclosure</button></> : <p role="status">Loading your disclosure…</p>}</div>;
  if (terms.state === 'closed') return <div className="bfd-card"><h1>Broker fee disclosure unavailable</h1><p>{terms.reason || 'Ask your agency for the current proposal.'}</p></div>;
  const discloseCommission = terms.quotes?.some(quote => quote.agencyCommissionPct !== undefined);
  return <div className="bfd-card">
    <p className="bfd-eyebrow">{terms.accountName}</p><h1>Broker fee disclosure and agreement</h1>
    <p>Review the broker fees for the policies below. These agency charges are separate from insurance premiums, taxes and other third-party charges. The agency may also receive compensation from the insurer.</p>
    <div className="bfd-table-wrap"><table><thead><tr><th>Policy / coverage</th><th>Policy term</th>{discloseCommission && <th>Carrier commission to agency</th>}<th>Broker fee</th></tr></thead><tbody>{terms.quotes?.map((quote, index) => <tr key={quote.id}><td><strong>{index + 1}. {quote.carrierName || 'Carrier'}</strong><br />{quote.lines?.filter(Boolean).join(', ')}</td><td>{quote.effectiveDate}<br />{quote.expirationDate}</td>{discloseCommission && <td>{quote.agencyCommissionPct !== undefined ? <>{money(quote.agencyCommissionCents || 0)} ({quote.agencyCommissionPct}%)</> : 'Not specified'}</td>}<td>{money(Math.round((quote.brokerFee || 0) * 100))}</td></tr>)}</tbody></table></div>
    <p className="bfd-total">Total broker fees <strong>{money(terms.totalCents || 0)}</strong></p>
    <h2>Services and payment</h2><p>{terms.purpose}</p><p>The broker fee is payable upfront and is excluded from premium financing. {terms.refundTerms}</p>
    {terms.stateForms?.map((form, index) => <section key={index} className="bfd-state-form"><h2>{form.title}</h2>{form.paragraphs.map((paragraph, row) => <p key={row}>{paragraph}</p>)}</section>)}
    {terms.agencySigner && <p>Agency electronic signature: <strong>/s/ {terms.agencySigner.name}</strong>, {terms.agencySigner.title}, license {terms.agencySigner.licenseNumber}.</p>}
    <p className="bfd-binding">Signing accepts the broker fees and state disclosures shown here. Client binding authorization and carrier confirmation remain separate; this signature does not authorize binding or establish coverage.</p>
    {terms.state === 'signed' ? <section aria-live="polite"><h2>Disclosure signed and saved</h2><p>Your signed disclosure has been saved with the policy documents.{terms.signedAt ? ` Signed ${new Date(terms.signedAt).toLocaleString()}.` : ''}</p>{terms.downloadUrl && <p><a href={terms.downloadUrl} target="_blank" rel="noreferrer">Download your signed disclosure</a></p>}{terms.payments?.length ? <><h2>Continue to your invoice</h2><p>Use the existing invoice payment link below. Broker fees are collected upfront.</p>{terms.payments.map((payment, index) => <p key={index}><a className="bfd-action" href={payment.url} rel="noreferrer">{payment.label}</a></p>)}</> : <p>Your agency will provide the normal invoice and payment link when the invoice is ready.</p>}</section> : <form onSubmit={sign}>
      <h2>Sign electronically</h2><div className="bfd-fields"><label>Your full name<input required minLength={2} maxLength={120} value={name} onChange={event => setName(event.target.value)} autoComplete="name" disabled={busy} /></label><label>Your email<input required type="email" maxLength={254} value={email} onChange={event => setEmail(event.target.value)} autoComplete="email" disabled={busy} /></label><label>Your role<input required minLength={2} maxLength={80} value={role} onChange={event => setRole(event.target.value)} placeholder="Board President, Property Manager, …" disabled={busy} /></label></div>
      <label className="bfd-consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} disabled={busy} /> <span>I am authorized to accept these fees for {terms.accountName}. I consent to electronic records and signatures and intend my typed name to sign this fee agreement and the state disclosures above. I can download and retain the signed agreement.</span></label>
      {error && <p role="alert" className="bfd-error">{error}</p>}<button className="bfd-action" disabled={busy || !consent || name.trim().length < 2 || role.trim().length < 2 || !email.trim()}>{busy ? 'Saving signature…' : 'Sign fee agreement'}</button>
    </form>}
  </div>;
}
