import type { ReactNode } from "react";
import { PHONE, PHONE_HREF } from "../../constants";
import LeadUploadPanel from "../LeadUploadPanel";
import { Icon } from "./icons";

/** The saved request and estimate remain visible while optional documents are added. */
export default function QuoteConfirmation({ estimate, uploadToken }: { estimate?: ReactNode; uploadToken?: string }) {
  return (
    <div className="qf-confirmation">
      <div className="qf-confirmation-grid">
        <div className="qf-confirmation-summary">
          <div className="qf-confirmation-heading">
            <svg className="qf-confirmation-check" width="36" height="36" viewBox="0 0 36 36" fill="none" aria-hidden="true">
              <circle cx="18" cy="18" r="18" fill="currentColor" />
              <path d="m10 18 5 5 11-12" stroke="var(--qf-bg)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <h2 tabIndex={-1}>Thank you. We have it.</h2>
          </div>
          <p className="qf-confirmation-intro">Your request is saved. Our team will be in touch within one business day.</p>
          {estimate}
        </div>
        {uploadToken && <LeadUploadPanel uploadToken={uploadToken} />}
      </div>
      <p className="qf-confirmation-disclaimer">
        This starts a review — it does not bind coverage or change an existing policy.
        Coverage is subject to underwriting, policy terms and eligibility. Carrier availability
        varies by state, association type and risk profile.
      </p>
      <div className="qf-confirmation-links">
        <a href={PHONE_HREF} className="qf-phone-cta"><Icon.Phone size={16} /><span>Call us — {PHONE}</span></a>
        <a href="/" className="qf-back-link">← Back to ProtectMyHOA.com</a>
      </div>
    </div>
  );
}
