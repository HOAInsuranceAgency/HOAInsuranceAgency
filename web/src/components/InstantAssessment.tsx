import { useState, useRef, useEffect, useCallback } from "react";
/* PHONE / PHONE_HREF come from here rather than being typed inline. This file
   used to carry four hand-written copies of the number — an error message, the
   success screen's tel: href and its visible label, and the "Prefer to talk?"
   block — which is four places to miss on the day the number changes. */
import { LEAD_EMAIL, LEAD_EMAIL_HREF, PHONE, PHONE_HREF, trackLead } from "../constants";
/* The licensed entity's name, interpolated rather than typed. `../constants`
   re-exports the contact details but not the name, and this lander names the
   operator twice in copy — under the submit button and above the phone number.
   `displayName` is the entity name without the LLC suffix, which is the form
   marketing copy uses; the full legal name lives on the LegalStrip below. */
import { AGENCY_FMT } from "../../../shared/agency";
import { useLeadSubmission } from "../lib/crmLead";
// One loader for the whole site — see lib/googlePlaces.ts.
import { loadGooglePlaces } from "../lib/googlePlaces";
import LeadUploadPanel from "./LeadUploadPanel";
import "./InstantAssessment.css";

/* ── Types ── */
interface Props {
  state?: string;
  stateAbbr?: string;
  region?: string;
  headline: string;
  subheadline: string;
  trustSignals?: string[];
  urgencyText?: string;
}

export function InstantAssessment({
  state,
  stateAbbr,
  region,
  headline,
  subheadline,
  trustSignals = [],
  urgencyText,
}: Props) {
  const [address, setAddress] = useState("");
  const [detectedState, setDetectedState] = useState(stateAbbr || "");
  const [units, setUnits] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  // Only set once intake accepts the lead — no token, no upload panel.
  const [uploadToken, setUploadToken] = useState<string | null>(null);
  const [error, setError] = useState("");
  const addressRef = useRef<HTMLInputElement>(null);
  const acRef = useRef<google.maps.places.Autocomplete | null>(null);

  const locationLabel = region || state || "Your Area";
  const source = region
    ? `Instant Assessment — ${region}`
    : state
      ? `Instant Assessment — ${state}`
      : "Instant Assessment — Generic";

  const initAC = useCallback(() => {
    if (!addressRef.current || acRef.current) return;
    try {
      const ac = new google.maps.places.Autocomplete(addressRef.current, {
        types: ["address"],
        componentRestrictions: { country: "us" },
        fields: ["address_components", "formatted_address"],
      });
      ac.addListener("place_changed", () => {
        const place = ac.getPlace();
        if (place.formatted_address) setAddress(place.formatted_address);
        if (place.address_components) {
          for (const c of place.address_components) {
            if (c.types.includes("administrative_area_level_1")) {
              setDetectedState(c.short_name?.toUpperCase() || "");
            }
          }
        }
      });
      acRef.current = ac;
    } catch { /* Maps not loaded */ }
  }, []);

  useEffect(() => {
    if (!stateAbbr) loadGooglePlaces().then(initAC).catch(() => {});
  }, [initAC, stateAbbr]);

  useEffect(() => {
    if (addressRef.current && window.google?.maps?.places && !acRef.current) initAC();
  });

  const leadSubmission = useLeadSubmission();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) { setError("Please enter your email."); return; }
    if (!name.trim()) { setError("Please enter your name."); return; }
    setSending(true);
    setError("");
    try {
      const received = await leadSubmission.submit({
      type: "ASSOCIATION",
      name: address.trim() || name.trim(),
      contactFirstName: name.trim().split(/\s+/)[0],
      contactLastName: name.trim().split(/\s+/).slice(1).join(" ") || undefined,
      contactEmail: email.trim(),
      contactPhone: phone.trim() || undefined,
      address: address.trim() || undefined,
      state: detectedState || undefined,
      source: `website-assessment:${source}`,
      unitCount: units ? String(units) : undefined,

      answerSnapshot: JSON.stringify({
          _subject: `🏢 Instant Assessment — ${name.trim()}${detectedState ? ` (${detectedState})` : ""}`,
          _template: "table",
          _captcha: "false",
          _replyto: email.trim(),
          "Full Name": name.trim(),
          Email: email.trim(),
          Phone: phone.trim() || "—",
          "Property Address": address || "—",
          State: detectedState || "—",
          "Unit Count": units || "—",
          Source: source,
        }),
      });
      setUploadToken(received.uploadToken);

      trackLead("instant_assessment");
      setSent(true);
    } catch {
      setError(`Something went wrong. Please try again or call ${PHONE}.`);
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    return (
      <div className="ia-success">
        <div className="ia-success-icon">
          <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
            <circle cx="32" cy="32" r="32" fill="#e5c16a20" />
            <circle cx="32" cy="32" r="24" fill="#e5c16a" />
            <path d="M20 32l8 8 16-18" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h2 className="ia-success-title">We're on it.</h2>
        {/* "Personalized coverage assessment" stays — it is what the team
            actually sends back. What follows it is the qualifier the rest of the
            site uses, because a submitted form is a request for an assessment
            and not the start of a policy. */}
        <p className="ia-success-text">
          We'll review your information and reach out within one business day with a
          personalized coverage assessment. Submitting this form does not bind coverage.
        </p>
        {/* Offered only after the lead is captured — an upload that
            never happens costs nothing at this point. */}
        {uploadToken && <LeadUploadPanel uploadToken={uploadToken} />}
        <a href={PHONE_HREF} className="ia-phone-link">
          Or call us now — {PHONE}
        </a>
        <a href="/" className="ia-back-link">← Back to ProtectMyHOA.com</a>
      </div>
    );
  }

  return (
    <div className="ia-container">
      <div className="ia-form-side">
        <h1 className="ia-headline">{headline}</h1>
        <p className="ia-sub">{subheadline}</p>

        {urgencyText && (
          <div className="ia-urgency">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
            <span>{urgencyText}</span>
          </div>
        )}

        <form className="ia-form" onSubmit={handleSubmit}>
          <div className="ia-row">
            <div className="ia-field">
              <label htmlFor="ia-name">Full Name *</label>
              <input id="ia-name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Smith" required />
            </div>
            <div className="ia-field">
              <label htmlFor="ia-email">Email *</label>
              <input id="ia-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane@example.com" required />
            </div>
          </div>

          <div className="ia-row">
            <div className="ia-field">
              <label htmlFor="ia-phone">Phone</label>
              <input id="ia-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(508) 555-1234" />
            </div>
            <div className="ia-field">
              <label htmlFor="ia-units">Number of Units</label>
              <input id="ia-units" type="number" min="1" value={units} onChange={(e) => setUnits(e.target.value)} placeholder="e.g. 48" />
            </div>
          </div>

          {!stateAbbr && (
            <div className="ia-field ia-field--full">
              <label htmlFor="ia-address">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
                Property Address
              </label>
              <input ref={addressRef} id="ia-address" type="text" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Start typing your address..." autoComplete="off" />
            </div>
          )}

          {error && <p className="ia-error">{error}</p>}

          <button type="submit" className="ia-submit" disabled={sending}>
            {sending ? "Sending..." : "Get My Free Assessment"}
            {!sending && (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M12 5l7 7-7 7"/>
              </svg>
            )}
          </button>

          {/* Names the licensed entity and says what the button does NOT do.
              The lander is heavily ProtectMyHOA-branded, and this line is the
              form's own answer to "who is receiving this, and am I now
              covered?" — the LegalStrip below repeats it in legal language, but
              a reader deciding whether to press the button is looking here. */}
          <p className="ia-disclaimer">
            Free and no obligation. {AGENCY_FMT.displayName} replies within one business day.
            Submitting this form does not bind coverage.
          </p>
        </form>
      </div>

      <div className="ia-trust-side">
        <div className="ia-logo-wrap">
          <img src="/logo.png" alt="HOA Insurance Agency" className="ia-logo" />
        </div>

        <div className="ia-what-you-get">
          <h3>What you'll receive:</h3>
          <ul>
            <li>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-6"/></svg>
              Personalized coverage recommendation
            </li>
            <li>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-6"/></svg>
              Gap analysis vs. your current policy
            </li>
            {/* Was "Competitive market comparison", which reads as a promise
                that the result will beat what the association has now. What is
                actually delivered is a comparison of the markets this agency can
                reach for that building, and those vary by state, association
                type and risk profile — so the item now says that instead. */}
            <li>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-6"/></svg>
              Comparison of the markets available to your association
            </li>
            <li>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-6"/></svg>
              Board-ready summary document
            </li>
          </ul>
        </div>

        {trustSignals.length > 0 && (
          <div className="ia-signals">
            {trustSignals.map((s, i) => (
              <div key={i} className="ia-signal">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2l8 4v6c0 5-3.5 9.5-8 10-4.5-.5-8-5-8-10V6l8-4z"/></svg>
                <span>{s}</span>
              </div>
            ))}
          </div>
        )}

        {/* Each route is labelled with what it is for. The block used to stack a
            bare number on a bare address, and the LegalStrip beneath this island
            prints the agency's general mailbox in the same flat style — two
            addresses, one screen, nothing saying which one gets a quote moving. */}
        <div className="ia-contact-alt">
          <p>Prefer to talk? Call {AGENCY_FMT.displayName}</p>
          <a href={PHONE_HREF}>{PHONE}</a>
          <p>New business and quote requests</p>
          <a href={LEAD_EMAIL_HREF}>{LEAD_EMAIL}</a>
        </div>
      </div>
    </div>
  );
}
