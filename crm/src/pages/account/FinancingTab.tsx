import { useMemo, useState } from "react";
import {
  client,
  fmtDate,
  fmtMoney,
  listAllPages,
  type Account,
  type Policy,
} from "../../lib/client";
import type { Schema } from "../../../amplify/data/resource";
import { useAsyncResource } from "../../lib/useAsyncResource";
import { useIsAdmin } from "../../lib/auth";
import { SaveStatus, useSaveStatus } from "../../components/SaveStatus";
import { originationGate } from "../../lib/premiumFinance/gate";
import {
  evaluateEligibility,
  eligibilityBlocked,
} from "../../lib/premiumFinance/eligibility";
import {
  buildQuote,
  PF_DEFAULT_APR,
  PF_DEFAULT_DOWN_PCT,
  PF_DEFAULT_MONTHS,
  PF_ORIGINATION_FEE,
} from "../../lib/premiumFinance/quote";
import { formatMoney } from "../../lib/invoiceTotals";
import { Badge, type BadgeSpec } from "../../lib/badges";

type PfLoan = Schema["PfLoan"]["type"];
type PfOverride = Schema["PfOverride"]["type"];

/**
 * Financing on one association: gate → policy → eligibility → quote → issue.
 *
 * Everything this panel shows is advisory rendering of the same pure modules
 * the origination Lambda runs — the checks it displays are the checks the
 * server re-runs, and the server's answer is the one that counts. The gate
 * keys off the association's PHYSICAL address state (Account.state, the ACORD
 * premises field) and must never be swapped for a mailing address.
 */

const LOAN_BADGE: Record<string, BadgeSpec> = {
  QUOTED: { cls: "blue", label: "QUOTED" },
  ACTIVE: { cls: "green", label: "ACTIVE" },
  PAID: { cls: "gray", label: "PAID" },
  DEFAULTED: { cls: "red", label: "DEFAULTED" },
  CANCELLED: { cls: "gray", label: "CANCELLED" },
};

export function FinancingTab({ account }: { account: Account }) {
  const isAdmin = useIsAdmin();
  const gate = useMemo(() => originationGate(account.state), [account.state]);

  const res = useAsyncResource(
    async () => {
      const [policies, loans, overrides] = await Promise.all([
        listAllPages((nextToken) =>
          client.models.Policy.list({
            filter: { accountId: { eq: account.id } },
            nextToken,
          })
        ),
        listAllPages((nextToken) =>
          client.models.PfLoan.list({
            filter: { accountId: { eq: account.id } },
            nextToken,
          })
        ),
        listAllPages((nextToken) =>
          client.models.PfOverride.list({ nextToken })
        ),
      ]);
      return {
        policies: (policies as Policy[]).filter((p) => p.status === "ACTIVE"),
        loans: loans as PfLoan[],
        overrides: overrides as PfOverride[],
      };
    },
    [account.id],
    { initialData: null, errorMessage: "Failed to load financing" }
  );

  const [policyId, setPolicyId] = useState("");
  const [premium, setPremium] = useState("");
  const [downPct, setDownPct] = useState(String(PF_DEFAULT_DOWN_PCT));
  const [months, setMonths] = useState(String(PF_DEFAULT_MONTHS));
  // 14.0 always — never a jurisdiction's cap (decision E).
  const [apr, setApr] = useState(String(PF_DEFAULT_APR));
  const [overrideReason, setOverrideReason] = useState("");
  const [overrideCheck, setOverrideCheck] = useState<"MEP" | "AUDITABLE" | "">("");
  const issueStatus = useSaveStatus();
  const overrideStatus = useSaveStatus({ autoClearMs: 4000 });
  const [issued, setIssued] = useState<string | null>(null);

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

  if (!res.loaded) return <p className="muted small">Loading…</p>;
  if (res.error) return <p className="error-text">{res.error}</p>;
  if (!res.data) return null;

  const { policies, loans, overrides } = res.data;
  const policy = policies.find((p) => p.id === policyId) ?? null;

  const policyOverrides = {
    mep: overrides.find(
      (o) => o.policyId === policyId && o.check === "MEP" && o.reason?.trim()
    ),
    auditable: overrides.find(
      (o) => o.policyId === policyId && o.check === "AUDITABLE" && o.reason?.trim()
    ),
  };

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
    Number.isFinite(parsed.apr) &&
    parsed.apr > 0;

  const checks = policy
    ? evaluateEligibility({
        lines: policy.lines ?? [],
        accountType: account.type,
        producerOfRecord: policy.producerOfRecord,
        minimumEarnedPremiumPct: policy.minimumEarnedPremiumPct,
        isAuditable: policy.isAuditable,
        downPct: Number.isFinite(parsed.downPct) ? parsed.downPct : PF_DEFAULT_DOWN_PCT,
        overrides: {
          mep: policyOverrides.mep ? { reason: policyOverrides.mep.reason } : undefined,
          auditable: policyOverrides.auditable
            ? { reason: policyOverrides.auditable.reason }
            : undefined,
        },
      })
    : [];
  const blockedNow = checks.length === 0 || eligibilityBlocked(checks);

  const today = new Date().toISOString().slice(0, 10);
  const quote =
    policy && inputsOk && !blockedNow
      ? buildQuote({ ...parsed, effectiveDate: policy.effectiveDate ?? today })
      : null;

  async function issue() {
    if (!policy) return;
    await issueStatus.run(
      async () => {
        const { data, errors } = await client.mutations.issueFinanceQuote({
          policyId: policy.id,
          premium: parsed.premium,
          downPct: parsed.downPct,
          months: parsed.months,
          apr: parsed.apr,
          effectiveDate: policy.effectiveDate ?? today,
        });
        if (errors?.length) throw new Error(errors[0].message);
        // AWSJSON arrives as a string — the lib/aiExtraction.ts trap.
        const result =
          typeof data === "string" ? JSON.parse(data) : (data as Record<string, unknown>);
        if (!result?.ok) throw new Error(String(result?.error ?? "Issue failed."));
        const blocks = (result.blocks ?? []) as { rule: string; reason: string }[];
        if (blocks.length > 0) {
          // The server saw something this panel did not. Its answer wins.
          throw new Error(blocks.map((b) => b.reason).join(" "));
        }
        setIssued(String(result.loanId));
        await res.refetch();
        return "Quote issued and logged.";
      },
      { errorMessage: "The server refused the quote." }
    );
  }

  /**
   * ADMIN creates the override row directly — the model rule enforces the
   * group, and the required reason IS the record. The origination log carries
   * it into the decision row when it is used.
   */
  async function addOverride() {
    if (!policy || !overrideCheck || !overrideReason.trim()) return;
    await overrideStatus.run(
      async () => {
        const { errors } = await client.models.PfOverride.create({
          policyId: policy.id,
          check: overrideCheck,
          reason: overrideReason.trim(),
          occurredAt: new Date().toISOString(),
        });
        if (errors?.length) throw new Error(errors[0].message);
        setOverrideReason("");
        setOverrideCheck("");
        await res.refetch();
        return "Override recorded.";
      },
      { errorMessage: "Couldn't record the override." }
    );
  }

  const CHECK_LABEL: Record<string, string> = {
    coverage: "Commercial lines only",
    "producer-of-record": "Producer of record",
    mep: "Minimum earned premium",
    auditable: "Auditable policy",
  };

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2>Financing</h2>
          <p className="muted small">{gate.jurisdiction.name} — open for origination</p>
        </div>

        <div className="field full policy-field">
          <label htmlFor="pf-policy">Policy to finance</label>
          <select
            id="pf-policy"
            value={policyId}
            onChange={(e) => {
              setPolicyId(e.target.value);
              const p = policies.find((x) => x.id === e.target.value);
              if (p?.premium) setPremium(String(p.premium));
            }}
          >
            <option value="">Choose…</option>
            {policies.map((p) => (
              <option key={p.id} value={p.id}>
                {p.policyNumber || (p.lines ?? []).filter(Boolean).join(", ") || "Policy"}
                {p.effectiveDate ? ` (${p.effectiveDate})` : ""}
              </option>
            ))}
          </select>
          {policies.length === 0 && (
            <p className="muted small">No active policies to finance.</p>
          )}
        </div>

        {policy && (
          <>
            {/* The four screens, as the server will run them. */}
            <ul className="check-list" style={{ marginBottom: 14 }}>
              {checks.map((c) => (
                <li key={c.check}>
                  <label style={{ cursor: "default" }}>
                    <span>
                      {c.ok ? "✓" : "✗"} {CHECK_LABEL[c.check]}
                      {c.overridden && <span className="badge amber">OVERRIDDEN</span>}
                      {!c.ok && c.reason && (
                        <span className="muted small">{c.reason}</span>
                      )}
                      {c.overridden && (
                        <span className="muted small">Reason: {c.overridden}</span>
                      )}
                    </span>
                  </label>
                </li>
              ))}
            </ul>

            {/* Overrides: MEP and auditable only, ADMIN only, reason required.
                The coverage screen has no override and never will. */}
            {isAdmin &&
              checks.some(
                (c) => !c.ok && (c.check === "mep" || c.check === "auditable")
              ) && (
                <div className="card inset">
                  <h3>Admin override</h3>
                  <div className="form-grid">
                    <div className="field">
                      <label htmlFor="pf-ov-check">Check</label>
                      <select
                        id="pf-ov-check"
                        value={overrideCheck}
                        onChange={(e) =>
                          setOverrideCheck(e.target.value as "MEP" | "AUDITABLE" | "")
                        }
                      >
                        <option value="">Choose…</option>
                        {checks.some((c) => c.check === "mep" && !c.ok) && (
                          <option value="MEP">Minimum earned premium</option>
                        )}
                        {checks.some((c) => c.check === "auditable" && !c.ok) && (
                          <option value="AUDITABLE">Auditable policy</option>
                        )}
                      </select>
                    </div>
                    <div className="field full">
                      <label htmlFor="pf-ov-reason">Written reason (required, permanent)</label>
                      <textarea
                        id="pf-ov-reason"
                        rows={2}
                        value={overrideReason}
                        onChange={(e) => setOverrideReason(e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="inline-actions">
                    <button
                      type="button"
                      className="secondary"
                      disabled={!overrideCheck || !overrideReason.trim() || overrideStatus.busy}
                      onClick={() => void addOverride()}
                    >
                      Record override
                    </button>
                    <SaveStatus {...overrideStatus.status} />
                  </div>
                </div>
              )}

            <div className="form-grid" style={{ marginTop: 14 }}>
              <div className="field">
                <label htmlFor="pf-premium">Total premium ($)</label>
                <input
                  id="pf-premium"
                  type="number"
                  step="0.01"
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

            {quote && (
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
                <p className="muted small">
                  Plus a flat {formatMoney(PF_ORIGINATION_FEE)} origination fee,
                  refunded in full on prepayment. Early payoff is the outstanding
                  principal only — the actuarial method; no other charge exists.
                </p>
              </>
            )}

            <div className="inline-actions">
              <button
                type="button"
                className="primary"
                disabled={issueStatus.busy || !quote || blockedNow}
                onClick={() => void issue()}
              >
                Issue quote
              </button>
              <SaveStatus {...issueStatus.status} />
            </div>
            {issued && (
              <p className="muted small">
                Quote {issued} issued. The agreement and servicing arrive in the
                next release; every check above was re-run and logged server-side.
              </p>
            )}
          </>
        )}
      </div>

      {loans.length > 0 && (
        <div className="card">
          <h2>Loans</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Quoted</th>
                  <th>Status</th>
                  <th className="num">Financed</th>
                  <th className="num">APR</th>
                  <th className="num">Payment</th>
                  <th className="num">Balance</th>
                  <th>Next due</th>
                </tr>
              </thead>
              <tbody>
                {[...loans]
                  .sort((a, b) => (b.quotedAt ?? "").localeCompare(a.quotedAt ?? ""))
                  .map((l) => (
                    <tr key={l.id}>
                      <td>{fmtDate(l.quotedAt?.slice(0, 10))}</td>
                      <td>
                        <Badge {...(LOAN_BADGE[l.status] ?? LOAN_BADGE.QUOTED)} />
                      </td>
                      <td className="num">{fmtMoney(l.amountFinanced)}</td>
                      <td className="num">{l.apr}%</td>
                      <td className="num">{fmtMoney(l.payment)}</td>
                      <td className="num">{fmtMoney(l.balance)}</td>
                      <td>{fmtDate(l.nextDueAt)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

export default FinancingTab;
