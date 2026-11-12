import { useState, type FormEvent } from "react";
import { PHONE, trackLead } from "../constants";
import { useLeadSubmission } from "../lib/crmLead";
import { US_STATE_CATALOG } from "../../../shared/usStates";
import "./BlogLeadForm.css";

const stateOptions = [...US_STATE_CATALOG].sort((a, b) => a.name.localeCompare(b.name));

/**
 * Blog lead capture, saved to the CRM like every other website form.
 *
 * "review" asks for an Insurance review at the end of an article. "briefing"
 * is the monthly board briefing signup in the listing sidebar; there is no
 * mailing service yet, so a signup reaches the team as a lead to follow up.
 * Both carry "Blog · <category>" as their Source answer, which is the label
 * the CRM brief shows for a form it has no name for.
 */
export function BlogLeadForm({
  variant,
  topic,
  articleTitle,
}: {
  variant: "review" | "briefing";
  topic?: string;
  articleTitle?: string;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [association, setAssociation] = useState("");
  const [state, setState] = useState("");
  const [renewal, setRenewal] = useState("");
  const [role, setRole] = useState("Board member");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const leadSubmission = useLeadSubmission();
  const review = variant === "review";
  const id = (field: string) => `blog-${variant}-${field}`;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !email.trim() || !phone.trim()) return;
    if (review && !association.trim()) return;
    setStatus("sending");
    const [first, ...rest] = name.trim().split(/\s+/);
    const sourceLabel = `Blog · ${topic ?? "Journal"}`;
    const request = review ? "Insurance review request" : "Monthly board briefing signup";
    try {
      await leadSubmission.submit({
        type: "ASSOCIATION",
        name: review ? association.trim() : name.trim(),
        contactFirstName: first,
        contactLastName: rest.join(" ") || undefined,
        contactEmail: email.trim(),
        contactPhone: phone.trim(),
        state: state || undefined,
        // A month input gives YYYY-MM; the CRM stores a full date.
        currentPolicyExpiration: renewal ? `${renewal}-01` : undefined,
        source: review ? "website-blog" : "website-blog-briefing",
        notes: [request, articleTitle && `Article: ${articleTitle}`, !review && `Role: ${role}`].filter(Boolean).join("\n"),
        answerSnapshot: JSON.stringify({
          _subject: `${request} — ${name.trim()}`,
          _template: "table",
          _captcha: "false",
          _replyto: email.trim(),
          Source: sourceLabel,
          Name: name.trim(),
          Email: email.trim(),
          Phone: phone.trim(),
          ...(review ? { Association: association.trim(), State: state, "Renewal month": renewal } : { Role: role }),
          ...(articleTitle ? { Article: articleTitle } : {}),
        }),
      });
      trackLead("contact");
      setStatus("sent");
    } catch {
      setStatus("error");
    }
  }

  if (status === "sent") {
    return (
      <div className={`blog-form blog-form--${variant} blog-form__done`} role="status">
        <strong>{review ? "Thank you. Your request is in." : "You’re on the list."}</strong>
        <p>{review ? "A member of our team will contact you within one business day." : "We’ll be in touch, and you can reply any time with a question."}</p>
      </div>
    );
  }

  return (
    <form className={`blog-form blog-form--${variant}`} onSubmit={handleSubmit}>
      <div className="blog-form__grid">
        <div className="blog-form__field">
          <label htmlFor={id("name")}>Your name</label>
          <input id={id("name")} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="blog-form__field">
          <label htmlFor={id("email")}>Email</label>
          <input id={id("email")} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div className="blog-form__field">
          <label htmlFor={id("phone")}>Phone</label>
          <input id={id("phone")} type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} required />
        </div>
        {review ? (
          <>
            <div className="blog-form__field">
              <label htmlFor={id("association")}>Association name</label>
              <input id={id("association")} autoComplete="organization" value={association} onChange={(e) => setAssociation(e.target.value)} required />
            </div>
            <div className="blog-form__field">
              <label htmlFor={id("state")}>State</label>
              <select id={id("state")} value={state} onChange={(e) => setState(e.target.value)}>
                <option value="">Select a state</option>
                {stateOptions.map(({ code, name }) => <option key={code} value={code}>{name}</option>)}
              </select>
            </div>
            <div className="blog-form__field">
              <label htmlFor={id("renewal")}>Renewal month <span>(optional)</span></label>
              <input id={id("renewal")} type="month" value={renewal} onChange={(e) => setRenewal(e.target.value)} />
            </div>
          </>
        ) : (
          <div className="blog-form__field">
            <label htmlFor={id("role")}>Your role</label>
            <select id={id("role")} value={role} onChange={(e) => setRole(e.target.value)}>
              <option>Board member</option>
              <option>Property manager</option>
              <option>Unit owner</option>
            </select>
          </div>
        )}
      </div>
      {status === "error" && <p className="blog-form__error">Something went wrong. Please try again or call us at {PHONE}.</p>}
      <button type="submit" className="btn btn-primary blog-form__submit" disabled={status === "sending"}>
        {status === "sending" ? "Sending..." : review ? "Request my review" : "Subscribe"}
      </button>
    </form>
  );
}
