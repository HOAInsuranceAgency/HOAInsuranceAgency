import { useMemo, useState } from "react";
import {
  client,
  fmtDate,
  listAllPages,
  type Account,
  type CrmDocument,
  type Policy,
} from "../../lib/client";
import type { Schema } from "../../../amplify/data/resource";
import { useAsyncResource } from "../../lib/useAsyncResource";
import { useIsAdmin } from "../../lib/auth";
import { SaveStatus, useSaveStatus } from "../../components/SaveStatus";
import {
  hasCurrentOpinion,
  jurisdictionFor,
  originationGate,
} from "../../lib/premiumFinance/gate";
import {
  evaluateEligibility,
  eligibilityBlocked,
} from "../../lib/premiumFinance/eligibility";
import {
  buildQuote,
  downPctViolation,
  PF_DEFAULT_APR,
  PF_DEFAULT_DOWN_PCT,
  PF_DEFAULT_MONTHS,
  PF_ORIGINATION_FEE,
} from "../../lib/premiumFinance/quote";
import { formatMoney } from "../../lib/invoiceTotals";
import { Badge, type BadgeSpec } from "../../lib/badges";

type PfLoan = Schema["PfLoan"]["type"];
type PfOverride = Schema["PfOverride"]["type"];
type PfNotice = Schema["PfNotice"]["type"];

/**
 * Post-issuance actions on one loan. Thin dispatch onto servicePfLoan — every
 * rule (staleness, the 15-day clock, the certificate requirement, the lending
 * account) is enforced server-side; these controls just ask, and show the
 * refusal verbatim when the answer is no.
 */
function LoanActions({ loan, onChanged }: { loan: PfLoan; onChanged: () => void }) {
  const status = useSaveStatus({ autoClearMs: 6000 });
  const [resolutionDate, setResolutionDate] = useState("");
  const [resolutionDocId, setResolutionDocId] = useState("");
  const [certNoticeId, setCertNoticeId] = useState("");
  const [certDate, setCertDate] = useState("");
  const [certNumber, setCertNumber] = useState("");
  const [cancelDate, setCancelDate] = useState("");
  const notices = useAsyncResource(
    () =>
      listAllPages((nextToken) =>
        client.models.PfNotice.list({
          filter: { loanId: { eq: loan.id } },
          nextToken,
        })
      ),
    [loan.id, loan.status],
    { initialData: [] as PfNotice[], errorMessage: "Failed to load notices" }
  );
  /**
   * The executed resolutions this account has on file. Documents carry no
   * visible id anywhere in the UI, so activation offers the valid candidates
   * by name instead of asking for an id to be pasted. The server still
   * re-checks account and category at ACTIVATE — a selection that went stale
   * (deleted, re-categorized) is refused there, not trusted from here.
   */
  const resolutions = useAsyncResource(
    () =>
      loan.status === "QUOTED"
        ? listAllPages((nextToken) =>
            client.models.Document.list({
              filter: {
                entityId: { eq: loan.accountId },
                category: { eq: "PF_RESOLUTION_EXECUTED" },
              },
              nextToken,
            })
          )
        : Promise.resolve([] as CrmDocument[]),
    [loan.id, loan.status],
    { initialData: [] as CrmDocument[], errorMessage: "Failed to load documents" }
  );

  async function act(action: string, extra: Record<string, string> = {}, done?: string) {
    await status.run(
      async () => {
        const { data, errors } = await client.mutations.servicePfLoan({
          loanId: loan.id,
          action,
          ...extra,
        });
        if (errors?.length) throw new Error(errors[0].message);
        const result =
          typeof data === "string" ? JSON.parse(data) : (data as Record<string, unknown>);
        if (!result?.ok) throw new Error(String(result?.error ?? "Refused."));
        await notices.refetch();
        onChanged();
        return done ?? "Done.";
      },
      { errorMessage: "The server refused that." }
    );
  }

  const uncertifiedIntents = notices.data.filter(
    (n) =>
      n.type === "INTENT_TO_CANCEL" &&
      !notices.data.some((c) => c.type === "CERT_OF_MAILING" && c.refNoticeId === n.id)
  );

  return (
    <div className="card inset">
      <div className="card-head">
        <h3>Servicing</h3>
        <SaveStatus {...status.status} />
      </div>

      {loan.status === "QUOTED" && (
        <div className="inline-actions">
          <div className="field">
            <label htmlFor={`pf-res-${loan.id}`}>Board resolution executed</label>
            <input
              id={`pf-res-${loan.id}`}
              type="date"
              value={resolutionDate}
              onChange={(e) => setResolutionDate(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor={`pf-resdoc-${loan.id}`}>Executed resolution</label>
            <select
              id={`pf-resdoc-${loan.id}`}
              value={resolutionDocId}
              onChange={(e) => setResolutionDocId(e.target.value)}
            >
              <option value="">Choose…</option>
              {resolutions.data.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            {resolutions.loaded && resolutions.data.length === 0 && (
              <p className="muted small">
                None on file — upload the signed copy under “Executed board
                resolution” on the Documents tab.
              </p>
            )}
          </div>
          <button
            type="button"
            className="primary"
            disabled={!resolutionDate || !resolutionDocId.trim() || status.busy}
            onClick={() =>
              void act(
                "ACTIVATE",
                {
                  boardResolutionExecutedAt: resolutionDate,
                  boardResolutionDocumentId: resolutionDocId.trim(),
                },
                "Loan activated."
              )
            }
          >
            Activate loan
          </button>
        </div>
      )}

      {(loan.status === "ACTIVE" || loan.status === "DEFAULTED") && (
        <div className="inline-actions">
          <button
            type="button"
            className="secondary"
            disabled={status.busy}
            onClick={() =>
              void act("POST_PAYMENT", {}, "Payment posted to the lending account.")
            }
          >
            {/* The down payment is payment 1 everywhere the schedule is shown,
                so financed installment n posts as payment n+1 of months+1. */}
            Post payment {(loan.paidThrough ?? 0) + 2} of {loan.months + 1}
          </button>
        </div>
      )}

      {loan.status === "DEFAULTED" && (
        <>
          <div className="inline-actions">
            <button
              type="button"
              className="danger"
              disabled={status.busy}
              onClick={() =>
                void act("NOTICE_INTENT", {}, "Intent notice recorded — the 15-day clock is running. Mail it and record the certificate.")
              }
            >
              Record notice of intent to cancel
            </button>
          </div>
          {uncertifiedIntents.length > 0 && (
            <div className="form-grid">
              <div className="field">
                <label>Notice</label>
                <select value={certNoticeId} onChange={(e) => setCertNoticeId(e.target.value)}>
                  <option value="">Choose…</option>
                  {uncertifiedIntents.map((n) => (
                    <option key={n.id} value={n.id}>
                      Intent of {n.occurredAt.slice(0, 10)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>USPS mailing date</label>
                <input type="date" value={certDate} onChange={(e) => setCertDate(e.target.value)} />
              </div>
              <div className="field">
                <label>Certificate number</label>
                <input value={certNumber} onChange={(e) => setCertNumber(e.target.value)} />
              </div>
              <div className="field">
                <label>&nbsp;</label>
                <button
                  type="button"
                  className="secondary"
                  disabled={!certNoticeId || !certDate || !certNumber.trim() || status.busy}
                  onClick={() =>
                    void act(
                      "RECORD_CERT",
                      { noticeId: certNoticeId, certMailedAt: certDate, certNumber },
                      "Certificate recorded."
                    )
                  }
                >
                  Record certificate
                </button>
              </div>
            </div>
          )}
          <div className="inline-actions">
            <div className="field">
              <label htmlFor={`pf-cx-${loan.id}`}>Cancellation effective</label>
              <input
                id={`pf-cx-${loan.id}`}
                type="date"
                value={cancelDate}
                onChange={(e) => setCancelDate(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="danger"
              disabled={!cancelDate || status.busy}
              onClick={() =>
                void act(
                  "REQUEST_CANCELLATION",
                  { cancellationEffectiveAt: cancelDate },
                  "Cancellation requested; carrier refund expected within 30 days."
                )
              }
            >
              Request cancellation
            </button>
          </div>
        </>
      )}

      {notices.data.length > 0 && (
        <ul className="check-list">
          {[...notices.data]
            .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
            .map((n) => (
              <li key={n.id}>
                <label style={{ cursor: "default" }}>
                  <span>
                    {n.occurredAt.slice(0, 10)} — {n.type.replaceAll("_", " ").toLowerCase()}
                    {n.certNumber && (
                      <span className="muted small">
                        USPS {n.certNumber}, mailed {n.certMailedAt}
                      </span>
                    )}
                    {n.clockExpiresAt && (
                      <span className="muted small">
                        clock expires {n.clockExpiresAt.slice(0, 10)}
                      </span>
                    )}
                  </span>
                </label>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

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

/**
 * Loan money keeps its cents — the schedule rounds to cents by spec, and a
 * balance is a ledger figure, not a headline. Absent stays "—" (a QUOTED loan
 * has no balance yet), which is why this is not `formatMoney` directly.
 */
function fmtLoanMoney(n: number | null | undefined): string {
  return n == null ? "—" : formatMoney(n);
}

export function FinancingTab({ account }: { account: Account }) {
  const isAdmin = useIsAdmin();
  /**
   * Conditional jurisdictions ask the opinion store before the gate answers
   * (decision D) — same context the origination Lambda assembles, so what
   * this tab shows is what the server will decide.
   */
  const j = useMemo(() => jurisdictionFor(account.state), [account.state]);
  const opinionsRes = useAsyncResource(
    async () => {
      if (j?.status !== "conditional") return true as boolean | null;
      const { data } = await client.models.PfCounselOpinion.list({
        filter: { jurisdiction: { eq: j.code } },
        limit: 100,
      });
      return hasCurrentOpinion(
        data.map((o) => ({ effectiveAt: o.effectiveAt, reviewBy: o.reviewBy })),
        new Date().toISOString().slice(0, 10)
      );
    },
    [j?.code, j?.status],
    { initialData: null }
  );
  const gate = useMemo(
    () =>
      originationGate(account.state, {
        hasCurrentCounselOpinion: opinionsRes.data === true,
      }),
    [account.state, opinionsRes.data]
  );

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
  const agreementStatus = useSaveStatus({ autoClearMs: 6000 });
  const [issued, setIssued] = useState<string | null>(null);
  const [openLoan, setOpenLoan] = useState<string | null>(null);

  /**
   * Renders the agreement + board resolution from the loan's frozen terms and
   * files both in Documents. Regenerating overwrites nothing — each run makes
   * fresh Document rows — so a re-quote leaves the old paper in the trail.
   */
  async function generateAgreement(loanId: string) {
    await agreementStatus.run(
      async () => {
        const { data, errors } = await client.mutations.generatePfAgreement({ loanId });
        if (errors?.length) throw new Error(errors[0].message);
        const result =
          typeof data === "string" ? JSON.parse(data) : (data as Record<string, unknown>);
        if (!result?.ok) throw new Error(String(result?.error ?? "Generation failed."));
        return "Agreement and board resolution filed in Documents.";
      },
      { errorMessage: "Couldn't generate the agreement." }
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
  // The 25% floor is a product term, not jurisdiction data — safe to state
  // client-side, unlike an APR cap. The server re-checks and logs it anyway.
  const downError = inputsOk ? downPctViolation(parsed.downPct) : null;

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
    policy && inputsOk && !downError && !blockedNow
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
      {/* The gate stops new originations only. A jurisdiction closing — or an
          account moving into one — must leave existing loans serviceable, so
          the blocked card replaces the origination form alone; the Loans
          section below renders either way. */}
      {!gate.open ? (
        <div className="card">
          <h2>Financing</h2>
          <p className="warn-inline">{gate.reason}</p>
          {/* Disabled and not clickable, with the reason as the tooltip —
              the signed rule for closed jurisdictions. */}
          <button type="button" disabled title={gate.reason}>
            Offer financing
          </button>
        </div>
      ) : (
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
            {downError && <p className="error-text">{downError}</p>}

            {quote && (
              <>
                <div className="form-grid" style={{ marginTop: 14 }}>
                  <div className="stat">
                    <div className="n">{formatMoney(quote.downPayment)}</div>
                    <div className="l">Down payment (1 of {parsed.months + 1})</div>
                  </div>
                  <div className="stat">
                    <div className="n">{formatMoney(quote.amountFinanced)}</div>
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
                  The down payment is payment 1 of {parsed.months + 1}, collected
                  at inception; the {parsed.months} financed installments follow
                  monthly as payments 2 through {parsed.months + 1}.
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
                Quote {issued} issued. Every check above was re-run and logged
                server-side. Generate the agreement and service the loan from
                the Loans table below.
              </p>
            )}
          </>
        )}
      </div>
      )}

      {loans.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h2>Loans</h2>
            <SaveStatus {...agreementStatus.status} />
          </div>
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
                  <th />
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
                      <td className="num">{fmtLoanMoney(l.amountFinanced)}</td>
                      <td className="num">{l.apr}%</td>
                      <td className="num">{fmtLoanMoney(l.payment)}</td>
                      <td className="num">{fmtLoanMoney(l.balance)}</td>
                      <td>{fmtDate(l.nextDueAt)}</td>
                      <td className="row-action">
                        <div className="row-tools">
                          {(l.status === "QUOTED" || l.status === "ACTIVE") && (
                            <button
                              type="button"
                              className="link"
                              disabled={agreementStatus.busy}
                              onClick={() => void generateAgreement(l.id)}
                            >
                              Agreement PDF
                            </button>
                          )}
                          <button
                            type="button"
                            className="link"
                            aria-expanded={openLoan === l.id}
                            onClick={() => setOpenLoan(openLoan === l.id ? null : l.id)}
                          >
                            {openLoan === l.id ? "Close" : "Service"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          {openLoan && loans.some((l) => l.id === openLoan) && (
            <LoanActions
              loan={loans.find((l) => l.id === openLoan)!}
              onChanged={() => void res.refetch()}
            />
          )}
        </div>
      )}
    </>
  );
}

export default FinancingTab;
