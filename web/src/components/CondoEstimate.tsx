/**
 * Condominium premium indication — the short path of the quote wizard.
 *
 * Three screens ask only what the carrier estimate needs: where the building
 * is, how big it is and what it would cost to rebuild, and who to send it to.
 * Everything downstream is the wizard's own, unchanged: answers go through
 * `buildCrmLead` and `useLeadSubmission` exactly as /quote sends them (same
 * "website-quote" source, so the CRM treats it as a quote request), and the
 * result screen is the wizard's `QuoteConfirmation` with `PriceIndication`.
 *
 * The CRM requests a carrier estimate only for a condominium with a street
 * address, city, two-letter state, at least 500 sq ft and a replacement cost
 * between $150,000 and $99,999,999 (honeycomb/contract.ts). Figures outside
 * that range are still accepted, as the full wizard accepts them: the lead is
 * saved and the confirmation says the team will follow up, without a price.
 */
import { useEffect, useRef, useState } from "react";
import PriceIndication from "./quote/PriceIndication";
import QuoteConfirmation from "./quote/QuoteConfirmation";
import NumberField from "./quote/NumberField";
import { BrandMark, PrimaryButton, SelectField, StepIndicator, SupportChip, ProgressBar } from "./quote/ui";
import { LIGHT, ThemeContext } from "./quote/theme";
import { validateText, type FormData } from "./quote/schema";
import { buildCrmLead } from "./quote/submission";
import { useLeadSubmission } from "../lib/crmLead";
import { attachAddressAutocomplete, loadGooglePlaces } from "../lib/googlePlaces";
import { takeHandoff } from "../lib/addressHandoff";
import { states as ALL_STATES } from "../data/states";
import { AGENCY } from "../../../shared/agency";
import { PHONE, PHONE_HREF, trackLead } from "../constants";

const STATE_OPTIONS = [...ALL_STATES]
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((s) => ({ value: s.abbr, label: s.name }));

const ROLE_OPTIONS = [
  { value: "board", label: "Board member / trustee" },
  { value: "manager", label: "Property manager" },
];

type Field = {
  key: string;
  label: string;
  placeholder?: string;
  kind?: "text" | "number" | "select" | "email" | "tel";
  options?: { value: string; label: string }[];
  half?: boolean;
  help?: string;
  optional?: boolean;
  places?: boolean;
  check?: (v: string) => string | null;
};

const SCREENS: { question: string; sub?: string; fields: Field[] }[] = [
  {
    question: "Where is the condominium?",
    sub: "The building’s street address, so the carrier can rate its location.",
    fields: [
      { key: "propertyAddress", label: "Street address", placeholder: "Start typing the address", places: true },
      { key: "city", label: "City", half: true },
      { key: "state", label: "State", kind: "select", options: STATE_OPTIONS, half: true },
      { key: "zip", label: "ZIP", half: true, optional: true },
      { key: "associationName", label: "Association name", half: true, optional: true, placeholder: "e.g. Harbor Point Condominium" },
    ],
  },
  {
    question: "About the building",
    sub: "Two figures drive the indication. Your best estimate is fine.",
    fields: [
      {
        key: "grossSquareFeet", label: "Gross building area (sq ft)", kind: "number", half: true, placeholder: "e.g. 25,000",
        help: "Include common areas and garages; exclude basements.",
        check: (v) => validateText(v.replace(/,/g, ""), "area", false),
      },
      {
        key: "replacementValue", label: "Building replacement cost ($)", kind: "number", half: true, placeholder: "e.g. 5,000,000",
        help: "Cost to rebuild, excluding land. Not market value.",
        check: (v) => validateText(v.replace(/,/g, ""), "replacement", false),
      },
      { key: "unitCount", label: "Number of units", kind: "number", half: true, optional: true, placeholder: "e.g. 48" },
    ],
  },
  {
    question: "Where should we send it?",
    sub: "Your indication appears on the next screen, and a licensed agent follows up.",
    fields: [
      { key: "contactName", label: "Full name", placeholder: "Full name" },
      { key: "role", label: "Your role", kind: "select", options: ROLE_OPTIONS, half: true },
      { key: "contactEmail", label: "Email", kind: "email", half: true, placeholder: "you@example.com", check: (v) => validateText(v, "email", false) },
      { key: "contactPhone", label: "Phone", kind: "tel", half: true, placeholder: "(555) 555-5555", check: (v) => validateText(v, "phone", false) },
    ],
  },
];

export default function CondoEstimate() {
  // The site's light brand theme, as the full wizard defaults to.
  useEffect(() => {
    document.documentElement.dataset.theme = "light";
  }, []);
  return (
    <ThemeContext.Provider value={LIGHT}>
      <CondoFlow />
    </ThemeContext.Provider>
  );
}

function CondoFlow() {
  const [screen, setScreen] = useState(0);
  const [data, setData] = useState<Record<string, string>>(() => {
    // Address typed into a hero box elsewhere on the site arrives here too.
    const handed = typeof window !== "undefined" ? takeHandoff() : null;
    return handed ? { ...handed } as Record<string, string> : {};
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ estimateToken?: string; uploadToken: string | null } | null>(null);
  const leadSubmission = useLeadSubmission();
  const placesRef = useRef<HTMLInputElement | null>(null);
  const current = SCREENS[screen];

  // Google Places on the street field; best-effort, a plain input still works.
  useEffect(() => {
    if (screen !== 0) return;
    let detach: (() => void) | null = null;
    let cancelled = false;
    loadGooglePlaces()
      .then(() => {
        if (cancelled || !placesRef.current) return;
        detach = attachAddressAutocomplete(placesRef.current, (place) => {
          setData((d) => ({
            ...d,
            propertyAddress: place.address || place.formatted,
            ...(place.city && !d.city ? { city: place.city } : {}),
            ...(place.state && !d.state ? { state: place.state } : {}),
            ...(place.zip && !d.zip ? { zip: place.zip } : {}),
          }));
          setErrors({});
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      detach?.();
    };
  }, [screen]);

  const set = (key: string, value: string) => {
    setData((d) => ({ ...d, [key]: value }));
    setErrors((e) => ({ ...e, [key]: "" }));
  };

  function validate(): boolean {
    const errs: Record<string, string> = {};
    for (const f of current.fields) {
      const v = (data[f.key] ?? "").trim();
      if (!v) {
        if (!f.optional) errs[f.key] = "Please complete this field.";
        continue;
      }
      const msg = f.check?.(v);
      if (msg) errs[f.key] = msg;
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function next() {
    if (!validate()) return;
    if (screen < SCREENS.length - 1) {
      setScreen(screen + 1);
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const answers: FormData = { ...data, propertyKind: "condominium" };
      const lead = buildCrmLead(answers);
      // Same intake as /quote; the note only records which page it came from.
      const result = await leadSubmission.submit({
        ...lead,
        notes: [lead.notes, "Path: condominium premium indication page"].filter(Boolean).join("\n"),
      });
      setDone({ estimateToken: result.estimateToken, uploadToken: result.uploadToken });
      trackLead("condo_estimate");
    } catch (err) {
      console.error("Condo estimate submission failed:", err);
      setError(`We couldn’t send your request. Please try again or call ${PHONE}.`);
    } finally {
      setSubmitting(false);
    }
  }

  const total = SCREENS.length;
  return (
    <div className={"qf-root" + (done ? " qf-root--submitted" : " qf-root--question")}>
      <ProgressBar current={done ? total : screen} total={total} />
      <header className="qf-bar">
        <div className="qf-bar-left">
          {screen > 0 && !done ? (
            <button type="button" className="qf-back-link" onClick={() => { setErrors({}); setScreen(screen - 1); }}>← Back</button>
          ) : (
            <a className="qf-back-link" href="/">← Back to site</a>
          )}
        </div>
        <BrandMark small />
        <div className="qf-bar-right"><span className="qf-bar-spacer" aria-hidden="true" /></div>
      </header>
      {!done && <StepIndicator current={screen + 1} total={total} />}
      {!done && <SupportChip phone={PHONE} href={PHONE_HREF} />}

      <div className="qf-stage">
        {done ? (
          <QuoteConfirmation
            estimate={<PriceIndication token={done.estimateToken} />}
            uploadToken={done.uploadToken ?? undefined}
          />
        ) : (
          <div>
            {screen === 0 && <p className="qf-sub-small qf-condo-kicker">Condominium associations · Premium indication in about a minute</p>}
            <h1 className="qf-question" tabIndex={-1}>{current.question}</h1>
            {current.sub && <p className="qf-sub-small">{current.sub}</p>}
            <div className="qf-group">
              {current.fields.map((f) => (
                <div key={f.key} className={"qf-group-field" + (f.half ? " qf-group-field--half" : "")}>
                  <label className="qf-label" htmlFor={`ce-${f.key}`}>
                    {f.label}
                    {f.optional && <span className="qf-optional"> · optional</span>}
                  </label>
                  {f.kind === "select" ? (
                    <SelectField id={`ce-${f.key}`} value={data[f.key] ?? ""} onChange={(v) => set(f.key, v)} options={f.options ?? []} />
                  ) : f.kind === "number" ? (
                    <NumberField
                      id={`ce-${f.key}`}
                      className="qf-input"
                      inputMode={f.key === "unitCount" ? "numeric" : "decimal"}
                      value={data[f.key] ?? ""}
                      placeholder={f.placeholder}
                      aria-describedby={f.help ? `ce-${f.key}-help` : undefined}
                      autoComplete="off"
                      onChange={(v) => set(f.key, v)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); next(); } }}
                    />
                  ) : (
                    <input
                      id={`ce-${f.key}`}
                      ref={f.places ? placesRef : undefined}
                      className="qf-input"
                      type={f.kind === "email" ? "email" : f.kind === "tel" ? "tel" : "text"}
                      value={data[f.key] ?? ""}
                      placeholder={f.placeholder}
                      autoComplete="off"
                      onChange={(e) => set(f.key, e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); next(); } }}
                    />
                  )}
                  {f.help && <p id={`ce-${f.key}-help`} className="qf-sub-small" style={{ margin: "6px 0 0", fontSize: 12 }}>{f.help}</p>}
                  {errors[f.key] && <p className="qf-error">{errors[f.key]}</p>}
                </div>
              ))}
            </div>
            {screen === total - 1 && (
              <p className="qf-sub-small qf-condo-consent">
                By submitting, you agree that {AGENCY.name} may contact you about this request by
                phone, text or email. Consent is not a condition of purchase. The indication is
                preliminary and non-binding, and is not a quote or binder.
              </p>
            )}
            {error && <p className="qf-error">{error}</p>}
            <PrimaryButton
              onClick={next}
              label={screen === total - 1 ? "See my premium indication" : "Continue"}
              disabled={submitting}
              loading={submitting}
            />
          </div>
        )}
      </div>

      <p className="qf-footer">
        {AGENCY.name} · {AGENCY.city}, {AGENCY.state}
      </p>
    </div>
  );
}
