import { useRef, useState } from "react";
import {
  client,
  fmtDate,
  friendlyError,
  listAllPages,
  type Account,
  type Policy,
} from "../../lib/client";
import type { Schema } from "../../../amplify/data/resource";
import { useAsyncResource } from "../../lib/useAsyncResource";
import { SaveStatus, useSaveStatus } from "../../components/SaveStatus";
import { formatMoney } from "../../lib/invoiceTotals";
import { Badge, type BadgeSpec } from "../../lib/badges";
import { isAuthorizationError } from "../../lib/authorizationError";

type PfLoan = Schema["PfLoan"]["type"];
type PfNotice = Schema["PfNotice"]["type"];

/**
 * Post-issuance actions on one loan. Thin dispatch onto servicePfLoan — every
 * rule (staleness, the 15-day clock, the certificate requirement, the lending
 * account) is enforced server-side; these controls just ask, and show the
 * refusal verbatim when the answer is no.
 */
function LoanActions({ loan, onChanged, refreshRequired, setRefreshRequired }: {
  loan: PfLoan;
  onChanged: (minimumPaidThrough?: number) => Promise<void>;
  refreshRequired: boolean;
  setRefreshRequired: (required: boolean) => void;
}) {
  const status = useSaveStatus({ autoClearMs: 6000 });
  const [certNoticeId, setCertNoticeId] = useState("");
  const [certDate, setCertDate] = useState("");
  const [certNumber, setCertNumber] = useState("");
  const [cancelDate, setCancelDate] = useState("");
  const postedInstallment = useRef<number>();
  const actionPending = useRef(false);
  const notices = useAsyncResource(
    () =>
      listAllPages((nextToken) =>
        client.models.PfNotice.list({
          filter: { loanId: { eq: loan.id } },
          nextToken,
        })
      ),
    [loan.id, loan.status],
    { initialData: [] as PfNotice[], errorMessage: "Failed to load notices", clearDataOnError: isAuthorizationError }
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
    { initialData: null as Policy | null, errorMessage: "Failed to check the bound policy", clearDataOnError: isAuthorizationError }
  );

  async function refreshAfterAction() {
    // This read must reject on failure. The ordinary resource refetch handles
    // errors internally, so awaiting it would unlock a stale installment.
    await onChanged(postedInstallment.current);
    await notices.refetch();
    setRefreshRequired(false);
    postedInstallment.current = undefined;
  }

  async function act(action: string, extra: Record<string, string> = {}, done?: string) {
    if (refreshRequired || actionPending.current) return;
    actionPending.current = true;
    try { await status.run(
      async () => {
        setRefreshRequired(true);
        // Record the intended installment before sending. Transport/GraphQL
        // errors can hide a successful commit, and an old read is not proof
        // that nothing was posted.
        if (action === "POST_PAYMENT") postedInstallment.current = (loan.paidThrough ?? 0) + 1;
        try {
          const { data, errors } = await client.mutations.servicePfLoan({
            loanId: loan.id,
            action,
            ...extra,
          });
          if (errors?.length) throw new Error(errors[0].message);
          const result =
            typeof data === "string" ? JSON.parse(data) : (data as Record<string, unknown>);
          if (!result?.ok) {
            throw new Error(String(result?.error ?? "Refused."));
          }
          if (action === "POST_PAYMENT") {
            const posted = result.posted as { n?: unknown } | undefined;
            postedInstallment.current = typeof posted?.n === "number"
              ? posted.n : (loan.paidThrough ?? 0) + 1;
          }
        } catch (error) {
          // A network error may have happened after the server committed.
          // Reconcile before enabling another request on the same loan.
          try { await refreshAfterAction(); } catch { /* Keep the retry barrier. */ }
          if (postedInstallment.current !== undefined) {
            throw new Error(`Payment status is unconfirmed. Refresh financing to check before another payment. ${friendlyError(error, "The response could not be confirmed.")}`);
          }
          throw error;
        }
        if (action === "RECORD_CERT") {
          setCertNoticeId("");
          setCertDate("");
          setCertNumber("");
        }
        try { await refreshAfterAction(); }
        catch { return `${done ?? "Done."} Could not refresh financing. Refresh before taking another action.`; }
      },
      { savedMessage: done ?? "Done.", errorMessage: "The server refused that." }
    ); } finally { actionPending.current = false; }
  }
  const busy = status.busy || refreshRequired;
  const noticesUnavailable = !notices.loaded || notices.loading || Boolean(notices.error);

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

      {refreshRequired && <p className="muted small">
        Financing must finish refreshing before another servicing action.{" "}
        <button type="button" className="secondary" disabled={status.busy}
          onClick={() => void status.run(refreshAfterAction, { savedMessage: "Financing refreshed.", errorMessage: "Could not refresh financing. Please retry." })}>
          Refresh financing
        </button>
      </p>}
      {notices.error && <p className="error-text" role="alert">
        {notices.error}{" "}
        <button type="button" className="secondary" disabled={notices.loading || busy} onClick={() => void notices.refetch()}>Retry notices</button>
      </p>}
      {rollTarget.error && <p className="error-text" role="alert">
        {rollTarget.error}{" "}
        <button type="button" className="secondary" disabled={rollTarget.loading || busy} onClick={() => void rollTarget.refetch()}>Retry bound policy</button>
      </p>}

      {loan.status === "ACCEPTED" && (
        <p className="muted small">
          The association elected financing{loan.electedAt ? ` on ${fmtDate(loan.electedAt.slice(0, 10))}` : ""}:
          down payment received{loan.downPaidAt ? ` ${fmtDate(loan.downPaidAt.slice(0, 10))}` : ""}, autopay
          mandate on file. Monthly collections are enabled automatically; no
          staff activation or document upload is needed to start billing.
        </p>
      )}

      {loan.quoteId && !loan.policyId && rollTarget.data && (
        <div className="inline-actions">
          <p className="muted small">
            This loan still anchors its quote, but the quote is bound —
            policy {rollTarget.data.policyNumber ?? rollTarget.data.id.slice(0, 8)} exists.
            Roll the loan onto it; the exclusion checks read
            the policy from then on.
          </p>
          <button
            type="button"
            className="secondary"
            disabled={busy || rollTarget.loading || Boolean(rollTarget.error)}
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

      {loan.status === "QUOTED" && loan.downPaymentIntentId && (
        <p className="muted small">Initial payment is processing. Monthly collections turn on automatically when it settles.</p>
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
            disabled={busy || Boolean(loan.autopayPendingIntentId)}
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
              disabled={busy || noticesUnavailable}
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
                <select aria-label="Notice" disabled={busy} value={certNoticeId} onChange={(e) => setCertNoticeId(e.target.value)}>
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
                <input aria-label="USPS mailing date" disabled={busy} type="date" value={certDate} onChange={(e) => setCertDate(e.target.value)} />
              </div>
              <div className="field">
                <label>Certificate number</label>
                <input aria-label="Certificate number" disabled={busy} value={certNumber} onChange={(e) => setCertNumber(e.target.value)} />
              </div>
              <div className="field">
                <label>&nbsp;</label>
                <button
                  type="button"
                  className="secondary"
                  disabled={!uncertifiedIntents.some(n => n.id === certNoticeId) || !certDate || !certNumber.trim() || busy || noticesUnavailable}
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
                disabled={busy}
                type="date"
                value={cancelDate}
                onChange={(e) => setCancelDate(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="danger"
              disabled={!cancelDate || busy || noticesUnavailable}
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
 * agreement paper, automatic monthly collection, posting, and the
 * notice-clocked cancellation sequence.
 */

const LOAN_BADGE: Record<string, BadgeSpec> = {
  QUOTED: { cls: "blue", label: "QUOTED" },
  /** Legacy settled election; the daily job automatically enables collection. */
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

async function readFinancing(accountId: string) {
  const loans = await listAllPages(nextToken => client.models.PfLoan.list({
    filter: { accountId: { eq: accountId } }, nextToken,
  }));
  return { loans: loans as PfLoan[] };
}

export function FinancingTab({ account }: { account: Account }) {
  return <AccountFinancing key={account.id} account={account} />;
}

function AccountFinancing({ account }: { account: Account }) {
  const res = useAsyncResource(
    () => readFinancing(account.id),
    [account.id],
    { initialData: null, errorMessage: "Failed to load financing", clearDataOnError: isAuthorizationError }
  );

  const agreementStatus = useSaveStatus({ autoClearMs: 6000 });
  const agreementPending = useRef(false);
  const [openLoan, setOpenLoan] = useState<string | null>(null);
  const [refreshRequired, setRefreshRequired] = useState(false);

  async function refreshServicedLoan(minimumPaidThrough?: number) {
    try {
      const fresh = await readFinancing(account.id);
      const serviced = fresh.loans.find(loan => loan.id === openLoan);
      if (minimumPaidThrough !== undefined && (!serviced || (serviced.paidThrough ?? 0) < minimumPaidThrough)) {
        throw new Error("The requested payment is not yet confirmed in the loan. Refresh again to check its status.");
      }
      res.setData(fresh);
    }
    catch (error) {
      if (isAuthorizationError(error)) {
        res.invalidate(error);
        setRefreshRequired(false);
      }
      throw error;
    }
  }

  /**
   * Renders the financing agreement from the loan's frozen terms and
   * files it in Documents with the signature recorded at deposit.
   */
  async function generateAgreement(loanId: string) {
    if (agreementPending.current) return;
    agreementPending.current = true;
    try { await agreementStatus.run(
      async () => {
        const { data, errors } = await client.mutations.generatePfAgreement({ loanId });
        if (errors?.length) throw new Error(errors[0].message);
        const result =
          typeof data === "string" ? JSON.parse(data) : (data as Record<string, unknown>);
        if (!result?.ok) throw new Error(String(result?.error ?? "Generation failed."));
        return "Financing agreement filed in Documents.";
      },
      { errorMessage: "Couldn't generate the agreement." }
    ); } finally { agreementPending.current = false; }
  }

  if (!res.loaded || (res.loading && !res.data)) return <p className="muted small">Loading…</p>;

  const loans = res.data?.loans ?? [];

  return (
    <>
      {res.error && <p className="error-text" role="alert">
        {res.error}{" "}
        <button className="secondary" disabled={res.loading || refreshRequired} onClick={() => void res.refetch()}>Retry financing</button>
      </p>}
      {res.data && loans.length === 0 && (
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
                            disabled={refreshRequired || res.loading}
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
              key={openLoan}
              loan={loans.find((l) => l.id === openLoan)!}
              onChanged={refreshServicedLoan}
              refreshRequired={refreshRequired}
              setRefreshRequired={setRefreshRequired}
            />
          )}
        </div>
      )}
    </>
  );
}

export default FinancingTab;
