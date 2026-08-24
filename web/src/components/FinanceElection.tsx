import { useEffect, useState } from "react";
import {
  acceptElection,
  fetchElectionTerms,
  type ElectionTerms,
} from "../lib/financeElection";
import "./FinanceElection.css";

/**
 * The page a board treasurer reaches from the "Set up financing" link in an
 * invoice email.
 *
 * One decision, stated plainly: the schedule as the agreement will disclose
 * it, and a single accept that goes straight to Stripe for the down payment
 * and the bank mandate. Everything that can refuse — a superseded quote, a
 * closed module, a premium already paid — arrives as words from the server;
 * this component renders states and never decides one.
 *
 * Token handling is `DocumentPortal`'s, verbatim in spirit: read `?t=`,
 * scrub it from the address bar, stash it per-tab so refresh survives. See
 * that component for why each piece exists. `?done=1` (Stripe's return trip)
 * renders the submitted view even before the webhook lands, because the
 * customer just watched themselves pay and the page should not disagree.
 */

const TOKEN_KEY = "fe:token:v1";

function takeToken(): { token: string | null; done: boolean } {
  if (typeof window === "undefined") return { token: null, done: false };
  let fromUrl: string | null = null;
  let done = false;
  try {
    const url = new URL(window.location.href);
    fromUrl = url.searchParams.get("t");
    done = url.searchParams.get("done") === "1";
    if (fromUrl || done) {
      url.searchParams.delete("t");
      url.searchParams.delete("done");
      window.history.replaceState({}, "", url.pathname + url.search + url.hash);
    }
  } catch {
    // Fall through to the stash.
  }
  try {
    if (fromUrl) {
      window.sessionStorage.setItem(TOKEN_KEY, fromUrl);
      return { token: fromUrl, done };
    }
    return { token: window.sessionStorage.getItem(TOKEN_KEY), done };
  } catch {
    return { token: fromUrl, done };
  }
}

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

export function FinanceElection() {
  const [{ token, done }] = useState(takeToken);
  const [terms, setTerms] = useState<ElectionTerms | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) {
      setError("This financing link is missing its code. Open it again from the invoice email.");
      return;
    }
    fetchElectionTerms(token)
      .then(setTerms)
      .catch((e: Error) => setError(e.message));
  }, [token]);

  async function accept() {
    if (!token || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await acceptElection(token);
      if (r.state === "checkout" && r.url) {
        window.location.assign(r.url);
        return; // Leaving the page; keep the button held down.
      }
      if (r.state === "done") {
        setTerms((t) => (t ? { ...t, state: "done" } : t));
      } else {
        setError(r.reason ?? "This financing offer is no longer open.");
      }
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  if (error && !terms) {
    return (
      <div className="fe">
        <h1>Financing</h1>
        <p className="fe--error">{error}</p>
      </div>
    );
  }
  if (!terms) {
    return (
      <div className="fe">
        <h1>Financing</h1>
        <p>Loading your offer…</p>
      </div>
    );
  }

  const totalPayments = terms.months + 1;

  if (done || terms.state === "done") {
    return (
      <div className="fe">
        <h1>You're set</h1>
        <p>
          Your down payment — payment 1 of {totalPayments || 12} — has been
          submitted, and your bank account is saved for the monthly payments
          that follow. Bank transfers usually clear within a few business days;
          we'll email a receipt once it settles.
        </p>
        <p>
          One thing remains on paper: your board's signed resolution
          authorizing the financing. Your agent will send it if they haven't
          already — monthly payments begin only after it's on file.
        </p>
      </div>
    );
  }
  if (terms.state === "active") {
    return (
      <div className="fe">
        <h1>Financing is in place</h1>
        <p>
          {terms.associationName}'s premium financing is set up and running.
          Nothing more to do here.
        </p>
      </div>
    );
  }
  if (terms.state === "closed") {
    return (
      <div className="fe">
        <h1>Financing</h1>
        <p className="fe--error">
          {terms.reason ?? "This financing offer is no longer open. Your agent can issue a fresh one."}
        </p>
      </div>
    );
  }

  return (
    <div className="fe">
      <h1>Finance {terms.associationName}'s premium</h1>
      <p>
        Instead of paying {money(terms.premium)} up front, pay{" "}
        <strong>{money(terms.downPayment)} today</strong> as payment 1 of{" "}
        {totalPayments}, then {terms.months} monthly payments of{" "}
        <strong>{money(terms.payment)}</strong>.
      </p>
      <table className="fe-terms">
        <tbody>
          <tr><td>Total premium</td><td>{money(terms.premium)}</td></tr>
          <tr><td>Down payment (payment 1 of {totalPayments})</td><td>{money(terms.downPayment)}</td></tr>
          <tr><td>Amount financed</td><td>{money(terms.amountFinanced)}</td></tr>
          <tr><td>Annual percentage rate</td><td>{terms.apr}%</td></tr>
          <tr><td>Monthly payment ({terms.months} payments)</td><td>{money(terms.payment)}</td></tr>
          <tr><td>Finance charge</td><td>{money(terms.totalInterest)}</td></tr>
          <tr><td>Origination fee (refunded in full on prepayment)</td><td>{money(terms.originationFee)}</td></tr>
        </tbody>
      </table>
      <p className="fe-fine">
        The down payment is collected today by bank transfer; the monthly
        payments are drawn from the same account automatically, starting once
        your board's signed resolution is on file with your agent. Early
        payoff is the outstanding principal only — the actuarial method; no
        other charge exists. Accepting closes the pay-in-full link on your
        invoice.
      </p>
      {error && <p className="fe--error">{error}</p>}
      <button type="button" className="fe-accept" disabled={busy} onClick={() => void accept()}>
        {busy ? "Starting your payment…" : `Accept and pay ${money(terms.downPayment)} down`}
      </button>
      <p className="fe-fine">
        You'll finish the down payment on Stripe, our payment processor, and
        choose the bank account your monthly payments come from.
      </p>
    </div>
  );
}
