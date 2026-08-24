import { useState } from "react";
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
import { SaveStatus, useSaveStatus } from "../../components/SaveStatus";
import { formatMoney } from "../../lib/invoiceTotals";
import { Badge, type BadgeSpec } from "../../lib/badges";

type PfLoan = Schema["PfLoan"]["type"];
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
      loan.status === "QUOTED" || loan.status === "ACCEPTED"
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

  /**
   * W8 rollover repair. The bind flow rolls quote-anchored loans onto the
   * new policy best-effort; when that step failed (a closed tab, a
   * transient error), the loan is stuck on a bound quote with no anchor
   * symmetry — and the bind button that would retry it is gone. This is
   * the retry: if the loan still anchors only a quote and that quote has a
   * policy, offer the roll here.
   */
  const rollTarget = useAsyncResource(
    () =>
      loan.quoteId && !loan.policyId
        ? listAllPages((nextToken) =>
            client.models.Policy.list({
              filter: { quoteId: { eq: loan.quoteId! } },
              nextToken,
            })
          ).then((ps) => (ps as Policy[])[0] ?? null)
        : Promise.resolve(null),
    [loan.id, loan.quoteId, loan.policyId],
    { initialData: null as Policy | null }
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

      {loan.status === "ACCEPTED" && (
        <p className="muted small">
          The association elected financing{loan.electedAt ? ` on ${fmtDate(loan.electedAt.slice(0, 10))}` : ""}:
          down payment received{loan.downPaidAt ? ` ${fmtDate(loan.downPaidAt.slice(0, 10))}` : ""}, autopay
          mandate on file. Monthly debits begin at activation — file the
          executed resolution below.
        </p>
      )}

      {loan.quoteId && !loan.policyId && rollTarget.data && (
        <div className="inline-actions">
          <p className="muted small">
            This loan still anchors its quote, but the quote is bound —
            policy {rollTarget.data.policyNumber ?? rollTarget.data.id.slice(0, 8)} exists.
            Roll the loan onto it; activation and the exclusion checks read
            the policy from then on.
          </p>
          <button
            type="button"
            className="secondary"
            disabled={status.busy}
            onClick={() =>
              void act(
                "BIND_ROLLOVER",
                { policyId: rollTarget.data!.id },
                "Loan rolled to the policy."
              )
            }
          >
            Roll to policy
          </button>
        </div>
      )}

      {(loan.status === "QUOTED" || loan.status === "ACCEPTED") && (
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
          {loan.stripePaymentMethodId && (
            <p className="muted small">
              {loan.autopayPendingIntentId
                ? `Autopay: a debit for installment ${loan.autopayPendingInstallment ?? "?"} is clearing.`
                : "Autopay is on — due installments debit themselves; posting by hand is for money that arrived another way."}
            </p>
          )}
          <button
            type="button"
            className="secondary"
            disabled={status.busy || Boolean(loan.autopayPendingIntentId)}
            onClick={() => void act("POST_PAYMENT", {}, "Payment posted.")}
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
 * Financing on one association — servicing only, since W8.
 *
 * Origination has no UI anywhere: an offer originates automatically when an
 * invoice is sent, at the product's fixed terms, through the server's gates.
 * What this tab holds is everything AFTER a loan exists — the loans table,
 * agreement paper, activation behind the resolution rule, posting, and the
 * notice-clocked cancellation sequence.
 */

const LOAN_BADGE: Record<string, BadgeSpec> = {
  QUOTED: { cls: "blue", label: "QUOTED" },
  /** Elected from the invoice email: down paid, mandate saved, paper pending. */
  ACCEPTED: { cls: "amber", label: "ACCEPTED" },
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
  const res = useAsyncResource(
    async () => {
      const loans = await listAllPages((nextToken) =>
        client.models.PfLoan.list({
          filter: { accountId: { eq: account.id } },
          nextToken,
        })
      );
      return { loans: loans as PfLoan[] };
    },
    [account.id],
    { initialData: null, errorMessage: "Failed to load financing" }
  );

  const agreementStatus = useSaveStatus({ autoClearMs: 6000 });
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

  const { loans } = res.data;

  return (
    <>
      {loans.length === 0 && (
        <div className="card">
          <h2>Financing</h2>
          <p className="muted small">
            No financing on this association. Offers originate automatically
            when an invoice is sent — at 25% down, 14% APR, 11 monthly
            installments — and appear here once one exists. See the Invoices
            tab.
          </p>
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
                          {(l.status === "QUOTED" ||
                            l.status === "ACCEPTED" ||
                            l.status === "ACTIVE") && (
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
