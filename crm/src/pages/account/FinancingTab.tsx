import { useMemo, useState } from "react";
import { fmtMoney, type Account } from "../../lib/client";
import {
  aprCapViolation,
  minPrincipalViolation,
  originationGate,
} from "../../lib/premiumFinance/gate";
import {
  buildQuote,
  PF_DEFAULT_APR,
  PF_DEFAULT_DOWN_PCT,
  PF_DEFAULT_MONTHS,
  PF_ORIGINATION_FEE,
} from "../../lib/premiumFinance/quote";
import { formatMoney } from "../../lib/invoiceTotals";

/**
 * Financing on one association: the jurisdiction gate, then the calculator.
 *
 * The gate keys off the association's PHYSICAL address state — Account.state,
 * the same field the ACORD premises block uses — and must never be swapped for
 * a mailing address if one is ever added (Addition B in the spec; the mailing
 * address is usually the management company's, often in another state).
 *
 * Closed means the action is disabled and not clickable, with the signed
 * note as the reason — never an enabled button that errors on submit. The
 * quote here is a calculator only: issuing (persisting, agreement, the
 * compliance-log write) is the server's job and re-runs every check.
 */
export function FinancingTab({ account }: { account: Account }) {
  const gate = useMemo(() => originationGate(account.state), [account.state]);

  const [premium, setPremium] = useState("");
  const [downPct, setDownPct] = useState(String(PF_DEFAULT_DOWN_PCT));
  const [months, setMonths] = useState(String(PF_DEFAULT_MONTHS));
  // 14.0 always — never a jurisdiction's cap (decision E).
  const [apr, setApr] = useState(String(PF_DEFAULT_APR));

  const parsed = {
    premium: Number(premium),
    downPct: Number(downPct),
    months: Number(months),
    apr: Number(apr),
  };
  const inputsOk =
    Number.isFinite(parsed.premium) &&
    parsed.premium > 0 &&
    parsed.downPct >= 0 &&
    parsed.downPct < 100 &&
    Number.isInteger(parsed.months) &&
    parsed.months >= 1 &&
    parsed.months <= 12 &&
    Number.isFinite(parsed.apr);

  const quote =
    gate.open && inputsOk
      ? buildQuote({
          ...parsed,
          effectiveDate: new Date().toISOString().slice(0, 10),
        })
      : null;

  /**
   * The same validators the issuance mutation will run. Shown here so a
   * violation is a message at typing time, but the UI is not the gate — the
   * server re-checks on issue.
   */
  const aprError =
    gate.open && inputsOk ? aprCapViolation(parsed.apr, gate.jurisdiction) : null;
  const principalError =
    gate.open && quote
      ? minPrincipalViolation(quote.amountFinanced, gate.jurisdiction)
      : null;

  if (!gate.open) {
    return (
      <div className="card">
        <h2>Financing</h2>
        <p className="warn-inline">{gate.reason}</p>
        {/* Disabled and not clickable, with the reason as the tooltip —
            the signed rule for closed jurisdictions. */}
        <button type="button" disabled title={gate.reason}>
          Offer financing
        </button>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>Financing</h2>
        <p className="muted small">
          {gate.jurisdiction.name} — open for origination
        </p>
      </div>

      <div className="form-grid">
        <div className="field">
          <label htmlFor="pf-premium">Total premium ($)</label>
          <input
            id="pf-premium"
            type="number"
            step="0.01"
            placeholder="0.00"
            value={premium}
            onChange={(e) => setPremium(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="pf-down">Down payment (%)</label>
          <input
            id="pf-down"
            type="number"
            step="1"
            value={downPct}
            onChange={(e) => setDownPct(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="pf-months">Installments (months)</label>
          <input
            id="pf-months"
            type="number"
            step="1"
            min="1"
            max="12"
            value={months}
            onChange={(e) => setMonths(e.target.value)}
          />
        </div>
        <div className="field">
          {/* No cap shown beside the field: the cap is a ceiling, not a
              suggestion. It appears only in a rejection message. */}
          <label htmlFor="pf-apr">APR (%)</label>
          <input
            id="pf-apr"
            type="number"
            step="0.1"
            value={apr}
            onChange={(e) => setApr(e.target.value)}
          />
        </div>
      </div>

      {aprError && <p className="warn-inline">{aprError}</p>}
      {principalError && <p className="warn-inline">{principalError}</p>}

      {quote && !aprError && !principalError && (
        <>
          <div className="form-grid" style={{ marginTop: 14 }}>
            <div className="stat">
              <div className="n">{fmtMoney(quote.downPayment)}</div>
              <div className="l">Down payment</div>
            </div>
            <div className="stat">
              <div className="n">{fmtMoney(quote.amountFinanced)}</div>
              <div className="l">Amount financed</div>
            </div>
            <div className="stat">
              <div className="n">{formatMoney(quote.payment)}</div>
              <div className="l">Monthly payment</div>
            </div>
            <div className="stat">
              <div className="n">{formatMoney(quote.totalInterest)}</div>
              <div className="l">Finance charge</div>
            </div>
          </div>

          <div className="table-wrap" style={{ marginTop: 14 }}>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Due</th>
                  <th className="num">Payment</th>
                  <th className="num">Interest</th>
                  <th className="num">Principal</th>
                  <th className="num">Balance</th>
                </tr>
              </thead>
              <tbody>
                {quote.schedule.map((row) => (
                  <tr key={row.n}>
                    <td>{row.n}</td>
                    <td>{row.dueDate}</td>
                    <td className="num">{formatMoney(row.payment)}</td>
                    <td className="num">{formatMoney(row.interest)}</td>
                    <td className="num">{formatMoney(row.principal)}</td>
                    <td className="num">{formatMoney(row.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">
            Plus a flat {formatMoney(PF_ORIGINATION_FEE)} origination fee,
            refunded in full on prepayment. Early payoff is the outstanding
            principal only — the actuarial method; no other charge exists.
          </p>
          <p className="muted small">
            A quote becomes an agreement in a later release: eligibility
            screens, the signed agreement PDF, and servicing land next. This
            calculator prices only.
          </p>
        </>
      )}
    </div>
  );
}

export default FinancingTab;
