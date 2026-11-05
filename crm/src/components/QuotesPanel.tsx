import { assertGraphqlErrors } from '../lib/apiResponse';
import { readBrokerFeeStatus, bindCommissionPolicy, type BrokerFeeStatus } from '../lib/brokerFees';
import { serviceFinanceLoan } from '../lib/billingApi';
import { useLiveUpdateBlock } from "../lib/useLiveUpdates";
import { Button } from "./ui/Button";
import { Table } from "./ui/Table";
import { Select } from "./ui/Select";
import { Input } from "./ui/Input";
import { useEffect, useRef, useState } from "react";
import QuotePackages from "./QuotePackages";
import "./QuotesPanel.css";
import { packageTerms } from '../../../shared/quotePackages';
import { client, fmtDate, fmtMoney, friendlyError, type Account, type Carrier, type Quote, type Policy } from "../lib/client";
import { listAllPages } from "../../../shared/pagination";
import { Badge, statusBadge, QUOTE_STATUS_BADGE } from "../lib/badges";
import { useAsyncResource } from "../lib/useAsyncResource";
import { isAuthorizationError } from "../../../shared/authorizationError";
import { useSort, SortTh } from "../lib/useSort";
import CoverageForm from "./CoverageForm";
import { communicationRequest } from "../lib/communications";
import { authorizedQuoteTerms } from "../../../shared/quoteAuthorization";
import { SaveStatus, useSaveStatus } from "./SaveStatus";
import {
  isOpenQuoteStatus,
  SELECTABLE_QUOTE_STATUSES,
} from "../../../shared/quoteStatus";
import { BILL_TYPE_OPTIONS, type BillType } from "../../../shared/enums";
import QuoteOfferExpiry from "./QuoteOfferExpiry";
import { quoteOfferDate } from "../lib/quoteOfferExpiry";
import { useAgencyDay } from "../lib/useAgencyDay";
import { brokerFeeCents } from "../../../shared/brokerFees";
import PolicyCharges from "./PolicyCharges";
import { readCarrierPaymentPreview } from '../lib/commissions';
import { COMMISSION_BASES } from '../../../shared/commissions';

/** Commission is baked into the premium — the $ figure is the agency's cut,
 * never an addition on top. */
export function commissionCell(q: {
  premium?: number | null;
  commissionPct?: number | null;
}): string {
  if (q.commissionPct == null) return "—";
  const dollars =
    q.premium != null ? fmtMoney((q.premium * q.commissionPct) / 100) : null;
  return dollars ? `${q.commissionPct}% · ${dollars}` : `${q.commissionPct}%`;
}

export function termsSummary(q: {
  perOccurrenceDeductible?: number | null;
  perUnitDeductible?: number | null;
  blanketLimit?: number | null;
  coinsurancePct?: number | null;
  replacementCostType?: string | null;
}): string {
  const parts = [
    q.perOccurrenceDeductible != null && `${fmtMoney(q.perOccurrenceDeductible)} occ ded`,
    q.perUnitDeductible != null && `${fmtMoney(q.perUnitDeductible)} unit ded`,
    q.blanketLimit != null && `${fmtMoney(q.blanketLimit)} blanket`,
    q.coinsurancePct != null && `${q.coinsurancePct}% coins`,
    q.replacementCostType,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "—";
}

/**
 * Quotes for an account. Binding a quote is the conversion event: it creates
 * a Policy and flips the account LEAD → CLIENT in place.
 */
export default function QuotesPanel(props: Parameters<typeof QuotesPanelContent>[0]) {
  return <QuotesPanelContent key={props.account.id} {...props} />;
}

function QuotesPanelContent({
  account,
  onAccountChange,
}: {
  account: Account;
  onAccountChange: (a: Account) => void;
}) {
  const today = useAgencyDay();
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Quote | null>(null);
  const [binding, setBinding] = useState<Quote | null>(null);
  const [bindError, setBindError] = useState("");
  const [authorization, setAuthorization] = useState<Quote | null>(null);
  const [clientAuthorized, setClientAuthorized] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const authorizationLock = useRef(false);
  // Auto-clearing: the status change is made from a per-row <select> that
  // then re-renders with the new value, and an open quote that moves to
  // DECLINED/LOST leaves the table entirely — there is no form to go dirty
  // and retire the confirmation, so a timer is what retires it.
  const statusSave = useSaveStatus({ autoClearMs: 4000 });
  const statusLock = useRef(false);
  useLiveUpdateBlock(showForm || !!editing || !!binding || !!authorization || authorizing);

  const quoteRes = useAsyncResource(
    () =>
      listAllPages((nextToken) =>
        client.models.Quote.list({
          filter: { accountId: { eq: account.id } },
          nextToken,
        })
      ),
    [account.id],
    { initialData: [] as Quote[], errorMessage: "Failed to load quotes", clearDataOnError: isAuthorizationError , live: true }
  );
  const quotes = quoteRes.data;
  // Identity-stable, so passing it to CoverageForm/BindForm no longer
  // re-renders them on every render of this panel.
  const refresh = quoteRes.refetch;

  // Carriers are agency-wide, not account-scoped, so they are their own
  // resource on their own (empty) deps: refreshing the quotes after a status
  // change or a bind must not re-read the whole carrier table.
  const carrierRes = useAsyncResource(
    () => listAllPages(nextToken => client.models.Carrier.list({ nextToken })),
    [],
    { initialData: [] as Carrier[], clearDataOnError: isAuthorizationError , live: true }
  );
  const carrierRows = carrierRes.data;

  async function setStatus(quote: Quote, status: Quote["status"]) {
    if (statusLock.current) return;
    statusLock.current = true;
    try { await statusSave.run(
      async () => {
        // `errors` used to be dropped: the refetch quietly restored the old
        // value and the user was told nothing.
        const { errors } = await client.models.Quote.update({
          id: quote.id,
          status,
          ...(["QUOTED", "PRESENTED"].includes(status) && !quote.readyAt ? { readyAt: new Date().toISOString() } : {}),
          ...(status === "PRESENTED" && !quote.presentedAt ? { presentedAt: new Date().toISOString() } : {}),
        });
        assertGraphqlErrors({ errors: errors });
        await refresh();
      },
      {
        savedMessage: `Quote set to ${status}.`,
        errorMessage: "Couldn't change that quote's status.",
      }
    ); } finally { statusLock.current = false; }
  }

  // Carrier picker order only — no header to click, so the default stands.
  const { sorted: carriers } = useSort(carrierRows, { name: (c) => c.name }, "name");

  const carrierName = (id: string | null | undefined) =>
    carriers.find((c) => c.id === id)?.name ?? "—";

  // Newest quote first, as the fetch used to order them.
  const { sorted, sortKey, dir, toggle } = useSort(
    quotes,
    {
      carrier: (q) => (q.carrierId ? carrierName(q.carrierId) : null),
      lines: (q) => (q.lines ?? []).filter(Boolean).join(", "),
      premium: (q) => q.premium,
      commission: (q) => q.commissionPct,
      effective: (q) => q.effectiveDate,
      offerExpiry: quoteOfferDate,
      status: (q) => q.status,
      created: (q) => q.createdAt,
    },
    "created",
    "desc"
  );

  return (
    <div className="quotes-workspace">
      <QuotePackages
        accountId={account.id}
        quotes={quotes}
        carriers={carrierRows}
      />
      <section className="card quotes-card" id="quote-list" aria-label="Quotes">
        <div className="quotes-heading">
          <div>
            <h2>Quotes</h2>
            <p>Manage carrier quotes and confirmed bindings.</p>
          </div>
          <Button
            variant={showForm ? "secondary" : "primary"}
            onClick={() => {
              setEditing(null);
              setShowForm(!showForm);
            }}
          >
            {showForm ? "Cancel" : "+ New quote"}
          </Button>
        </div>

        <div className="quotes-save-status">
          {/* Per-row status changes share one status line. */}
          <SaveStatus {...statusSave.status} />
        </div>

        {(showForm || editing) && (
          <div className="quotes-editor">
            <CoverageForm
              key={editing?.id ?? "new"}
              kind="quote"
              accountId={account.id}
              carriers={carriers}
              existing={editing}
              onSaved={() => {
                setShowForm(false);
                setEditing(null);
                refresh();
              }}
              onCancel={() => {
                setShowForm(false);
                setEditing(null);
              }}
            />
          </div>
        )}

        {/* Surfaced rather than ignored: without carriers every row's first
          column reads "—", which is indistinguishable from quotes genuinely
          having no carrier set. */}
        {carrierRes.error && (
          <p className="error-text quotes-feedback" role="alert">
            {carrierRes.error} <Button variant="secondary"  disabled={carrierRes.loading} onClick={() => void carrierRes.refetch()}>Retry carriers</Button>
          </p>
        )}

        {!quoteRes.loaded || (quoteRes.loading && quotes.length === 0) ? (
          <div className="quotes-state" role="status">
            Loading quotes…
          </div>
        ) : quoteRes.error ? (
          <div className="quotes-state quotes-state--error" role="alert">
            <p>{quoteRes.error}</p>
            <Button variant="secondary"  onClick={() => void refresh()}>
              Retry quotes
            </Button>
          </div>
        ) : quotes.length === 0 ? (
          !showForm && !editing && (
            <div className="quotes-state quotes-state--empty">
              <strong>No quotes yet</strong>
              <p>Add a carrier quote to record pricing, coverage, and terms.</p>
            </div>
          )
        ) : (
          <div className="table-wrap quotes-table" aria-busy={quoteRes.loading}>
            <Table aria-label="Carrier quotes">
              <thead>
                <tr>
                  <SortTh
                    label="Carrier"
                    colKey="carrier"
                    sortKey={sortKey}
                    dir={dir}
                    onToggle={toggle}
                  />
                  <SortTh
                    label="Lines"
                    colKey="lines"
                    sortKey={sortKey}
                    dir={dir}
                    onToggle={toggle}
                  />
                  <SortTh
                    label="Premium"
                    colKey="premium"
                    sortKey={sortKey}
                    dir={dir}
                    onToggle={toggle}
                  />
                  <SortTh
                    label="Commission"
                    colKey="commission"
                    sortKey={sortKey}
                    dir={dir}
                    onToggle={toggle}
                  />
                  <th>Terms</th>
                  <SortTh
                    label="Effective"
                    colKey="effective"
                    sortKey={sortKey}
                    dir={dir}
                    onToggle={toggle}
                  />
                  <SortTh
                    label="Offer valid through"
                    colKey="offerExpiry"
                    sortKey={sortKey}
                    dir={dir}
                    onToggle={toggle}
                  />
                  <SortTh
                    label="Status"
                    colKey="status"
                    sortKey={sortKey}
                    dir={dir}
                    onToggle={toggle}
                  />
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((qt) => (
                  <tr key={qt.id}>
                    <td>{carrierName(qt.carrierId)}</td>
                    <td className="small">
                      {(qt.lines ?? []).filter(Boolean).join(", ") || "—"}
                    </td>
                    <td>{fmtMoney(qt.premium)}<PolicyCharges source={qt} /></td>
                    <td className="small">{commissionCell(qt)}</td>
                    <td className="small">{termsSummary(qt)}</td>
                    <td>{fmtDate(qt.effectiveDate)}</td>
                    <td><QuoteOfferExpiry quote={qt} today={today} /></td>
                    <td>
                      <Badge {...statusBadge(QUOTE_STATUS_BADGE, qt.status)} />
                    </td>
                    <td>
                      <div className="quotes-row-actions">
                        <Button variant="link"
                          className="quote-action"
                          onClick={() => {
                            setShowForm(false);
                            setEditing(qt);
                          }}
                        >
                          Edit
                        </Button>
                        {isOpenQuoteStatus(qt.status) && (
                          <>
                            <Select
                              className="quote-status-select"
                              aria-label="Quote status"
                              disabled={statusSave.busy || !!binding}
                              value={qt.status}
                              onChange={(e) =>
                                setStatus(qt, e.target.value as Quote["status"])
                              }
                            >
                              {[...SELECTABLE_QUOTE_STATUSES]
                                .sort((a, b) => a.localeCompare(b))
                                .map((s) => (
                                  <option key={s}>{s}</option>
                                ))}
                            </Select>{" "}
                            <Button variant="link"
                              className="quote-action"
                              disabled={statusSave.busy || !!binding}
                              onClick={() => setBinding(qt)}
                            >
                              Bind
                            </Button>
                            {["QUOTED", "PRESENTED"].includes(qt.status) &&
                              (!qt.bindAuthorizedAt ||
                                qt.bindAuthorizedTerms !==
                                  authorizedQuoteTerms(qt)) && (
                                <Button variant="link"
                                  className="quote-action"
                                  onClick={() => {
                                    setAuthorization(qt);
                                    setClientAuthorized(false);
                                  }}
                                >
                                  Request binding
                                </Button>
                              )}
                            {qt.bindAuthorizedAt && (
                              <span className="small muted quote-confirmation">
                                Carrier confirmation pending
                              </span>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}

        {authorization && (
          <section
            className="quote-flow-panel"
            aria-label="Client bind authorization"
          >
            <h3>Request binding</h3>
            <p className="quote-flow-summary">
              {carrierName(authorization.carrierId)} ·{" "}
              {fmtMoney(authorization.premium)} premium · Effective{" "}
              {fmtDate(authorization.effectiveDate)}
            </p>
            <PolicyCharges source={authorization} />
            {authorization.clientConditions && <p className="small" style={{ whiteSpace: "pre-wrap" }}>{authorization.clientConditions}</p>}
            <p className="muted small">
              This records the client's approval of these quoted terms. Carrier
              confirmation is still required before recording coverage as bound.
            </p>
            <label className="quote-authorization-check">
              <Input
                type="checkbox"
                checked={clientAuthorized}
                disabled={authorizing}
                onChange={(e) => setClientAuthorized(e.target.checked)}
              />{" "}
              The client has authorized binding these terms.
            </label>
            <div className="form-actions quote-flow-actions">
              <Button variant="primary"

                disabled={!clientAuthorized || authorizing}
                onClick={async () => {
                  if (authorizationLock.current) return;
                  authorizationLock.current = true;
                  setAuthorizing(true);
                  setBindError("");
                  try {
                    await communicationRequest(
                      "authorizeBind",
                      {
                        quoteId: authorization.id,
                        updatedAt: authorization.updatedAt,
                        clientAuthorized,
                      },
                      true,
                    );
                    setAuthorization(null);
                    await refresh();
                  } catch (e) {
                    setBindError(
                      friendlyError(e, "Could not record authorization"),
                    );
                  } finally {
                    authorizationLock.current = false;
                    setAuthorizing(false);
                  }
                }}
              >
                Record binding authorization
              </Button>
              <Button variant="secondary"

                disabled={authorizing}
                onClick={() => setAuthorization(null)}
              >
                Cancel
              </Button>
            </div>
          </section>
        )}
        {binding && (
          <BindForm
            key={binding.id}
            quote={binding}
            account={account}
            onDone={(updated) => {
              setBinding(null);
              refresh();
              if (updated) onAccountChange(updated);
            }}
            onError={setBindError}
          />
        )}
        {bindError && (
          <p className="error-text quotes-feedback" role="alert">
            {bindError}
          </p>
        )}
      </section>
    </div>
  );
}

function BindForm({
  quote,
  account,
  onDone,
  onError,
}: {
  quote: Quote;
  account: Account;
  onDone: (updatedAccount: Account | null) => void;
  onError: (msg: string) => void;
}) {
  const [policyNumber, setPolicyNumber] = useState("");
  const [premium, setPremium] = useState(quote.premium == null ? "" : String(quote.premium));
  const [agencyRate, setAgencyRate] = useState(quote.commissionPct == null ? "" : String(quote.commissionPct));
  const [confirmed, setConfirmed] = useState(false);
  /**
   * Reuse the fee quote's recorded answer; otherwise there is no default.
   * Bill type decides whether anyone here is supposed to collect
   * the premium, and a pre-selected answer to that is one nobody reads — the
   * first policy silently marked agency bill when the carrier is billing the
   * association directly is an invoice sent for money already paid.
   */
  const [billType, setBillType] = useState<BillType | "">(quote.billType ?? "");
  const hasBrokerFee = (quote.brokerFee ?? 0) > 0;
  const [paymentConfirmation, setPaymentConfirmation] = useState('');
  const paymentPreview = useAsyncResource(
    () => readCarrierPaymentPreview(quote.id, billType),
    [quote.id, quote.updatedAt, billType],
    { manual: !billType || (hasBrokerFee && billType !== "AGENCY"), clearDataOnError: () => true , live: true },
  );
  const paymentKey = JSON.stringify({ billType, preview: paymentPreview.data });
  const paymentReady = !!paymentPreview.data && !paymentPreview.loading && !paymentPreview.error &&
    (!paymentPreview.data.payment || paymentConfirmation === paymentKey);
  const [saving, setSaving] = useState(false);
  useLiveUpdateBlock(saving);
  const feeStatus = useAsyncResource(async () => {
    if (!(quote.brokerFee && quote.brokerFee > 0)) return null;
    const fees = await readBrokerFeeStatus(account.id, [quote.id]);
    return fees.find(fee => fee.quoteId === quote.id) ?? null;
  }, [quote.id, quote.brokerFee, account.id], { initialData: null as BrokerFeeStatus | null, errorMessage: "Could not load broker fee status", live: { protectEdits: false, intervalMs: 15_000 } });
  const currentFeeSigned = Boolean(feeStatus.data?.signedAt && feeStatus.data.amountCents === brokerFeeCents(quote.brokerFee) && feeStatus.data.terms === authorizedQuoteTerms(quote));
  const bindLock = useRef(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  // A quote must carry real terms before it can become a policy.
  const blockers = [
    quote.bindAuthorizedAt && quote.bindAuthorizedTerms !== authorizedQuoteTerms(quote) && "renewed client authorization for the changed terms",
    !quote.carrierId && "a carrier",
    !(quote.premium && quote.premium > 0) && "a premium",
    !quote.effectiveDate && "an effective date",
    !quote.expirationDate && "an expiration date",
    quote.commissionPct == null && "the exact agency commission percentage",
    !(quote.lines ?? []).filter(Boolean).length && "at least one line",
    hasBrokerFee && quote.billType !== "AGENCY" && "agency billing for the broker fee",
  ].filter(Boolean) as string[];

  async function bind() {
    // Belt and braces: the button is disabled without one, but `bind` is the
    // thing that writes the row and an unset bill type must never reach it.
    if (!billType || (hasBrokerFee && billType !== "AGENCY") || !confirmed || !paymentReady || bindLock.current) return;
    bindLock.current = true;
    let policyCreated = false;
    setSaving(true);
    onError("");
    try {
      const result = await bindCommissionPolicy({
        quoteId: quote.id, terms: packageTerms(quote), premium, agencyRate, billType, policyNumber,
        carrierTermsVersion: paymentPreview.data!.carrierTermsVersion,
        carrierArrangementId: paymentPreview.data!.payment?.id,
      });
      const policy = result.policy;
      policyCreated = true;

      /**
       * 2.5 (W8) The quote's billing follows it onto the policy: invoices
       * re-anchor by gaining the policy id (they keep quoteId — the anchor
       * scans match either), and live loans roll through the servicing
       * action, since clients cannot write loans. This runs AFTER the
       * policy exists and never aborts the bind — a rollover failure must
       * not tempt anyone to click Bind twice and mint a second policy.
       * Each item rolls independently, so one refusal doesn't strand the
       * rest; the Financing tab carries the retry for a stuck loan.
       */
      const rollFailures: string[] = [];
      try {
        const quoteInvoices = await listAllPages((nextToken) =>
          client.models.Invoice.list({
            filter: { quoteId: { eq: quote.id } },
            nextToken,
          })
        );
        for (const inv of quoteInvoices) {
          if (inv.policyId) continue;
          const { errors } = await client.models.Invoice.update({
            id: inv.id,
            policyId: policy.id,
          });
          if (errors?.length) {
            rollFailures.push(`invoice ${inv.number ?? inv.id}: ${errors[0].message}`);
          }
        }
        // Documents linked to the quote follow it too — same rule as the
        // invoice: the link gains the policy id and keeps the quote's.
        const quoteDocs = await listAllPages((nextToken) =>
          client.models.Document.list({
            filter: { quoteId: { eq: quote.id } },
            nextToken,
          })
        );
        for (const doc of quoteDocs) {
          if (doc.policyId) continue;
          const { errors } = await client.models.Document.update({
            id: doc.id,
            policyId: policy.id,
          });
          if (errors?.length) {
            rollFailures.push(`document ${doc.name}: ${errors[0].message}`);
          }
        }
        const quoteLoans = await listAllPages((nextToken) =>
          client.models.PfLoan.list({
            filter: { quoteId: { eq: quote.id } },
            nextToken,
          })
        );
        for (const loan of quoteLoans) {
          const live = ["QUOTED", "ACCEPTED", "ACTIVE", "DEFAULTED"].includes(loan.status);
          if (!live || loan.policyId) continue;
          try {
            await serviceFinanceLoan({ loanId: loan.id, action: 'BIND_ROLLOVER', policyId: policy.id });
          } catch (err) {
            rollFailures.push(`loan ${loan.id.slice(0, 8)}: ${(err as Error).message}`);
          }
        }
      } catch (err) {
        rollFailures.push((err as Error).message);
      }
      if (rollFailures.length && live.current) {
        onError(
          `Policy bound, but some billing didn't roll onto it: ${rollFailures.join("; ")}. The Financing tab can re-run a stuck loan's rollover.`
        );
      }

      if (live.current) onDone(result.account);
    } catch (err) {
      const message = friendlyError(err, "Bind failed");
      if (live.current) onError(policyCreated ? `Policy created, but binding did not finish: ${message}. Check the policies and account before retrying.` : message);
      if (policyCreated && live.current) onDone(null);
      if (!policyCreated && live.current) void paymentPreview.refetch();
    } finally {
      bindLock.current = false;
      setSaving(false);
    }
  }

  return (
    <section
      className="quote-flow-panel quote-flow-panel--bind"
      aria-label="Bind quote"
    >
      <h3>Bind quote</h3>
      <p className="small muted">
        Creates a policy
        {account.stage === "LEAD" ? " and converts this lead to a client" : ""}.
      </p>
      {blockers.length > 0 ? (
        <>
          <p className="error-text">
            This quote can't be bound yet — it needs {blockers.join(", ")}. Edit
            the quote details first.
          </p>
          <div className="form-actions quote-flow-actions">
            <Button variant="secondary"  onClick={() => onDone(null)}>
              Close
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="small muted">Confirm the exact commissionable premium and agency percentage from the accepted quote. To change either amount, edit the quote first. Producer earnings follow receipts and the agreement saved by the Owner. Broker fees use the same producer share, separately from carrier commission.</p>
          {(quote.brokerFee ?? 0) > 0 && <div className="small" role="status"><strong>Broker fee: {fmtMoney(quote.brokerFee)}</strong><p>{feeStatus.loading ? "Checking signed disclosure and payment…" : feeStatus.error || (!currentFeeSigned ? "Client signature is needed on the current broker fee disclosure." : feeStatus.data!.collectedCents >= feeStatus.data!.amountCents ? "Disclosure signed · payment received." : feeStatus.data!.submittedCents >= feeStatus.data!.amountCents ? "Disclosure signed · payment submitted and clearing." : "Disclosure signed · fee payment is still needed.")}</p>{feeStatus.error && <Button variant="link" disabled={feeStatus.loading || saving} onClick={() => void feeStatus.refetch()}>Retry fee status</Button>}</div>}
          <div className="form-grid">
            <label className="field">Exact policy premium ($)<Input aria-label="Exact policy premium" inputMode="decimal" value={premium} disabled={saving} onChange={e => { setPremium(e.target.value); setConfirmed(false); }} /></label>
            <label className="field">Agency commission (%)<Input aria-label="Agency commission percentage" inputMode="decimal" value={agencyRate} disabled={saving} onChange={e => { setAgencyRate(e.target.value); setConfirmed(false); }} /></label>
            <div className="field">
              <label htmlFor="bind-bill-type">Bill type (required)</label>
              <Select
                id="bind-bill-type"
                value={billType}
                disabled={saving || (quote.brokerFee ?? 0) > 0}
                onChange={(e) => setBillType(e.target.value as BillType | "")}
              >
                <option value="">Choose…</option>
                {BILL_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value} disabled={hasBrokerFee && o.value === "DIRECT"}>
                    {o.label}
                  </option>
                ))}
              </Select>
              {hasBrokerFee && <p className="small muted">Broker fees require agency billing, as set on the accepted quote.</p>}
            </div>
            <div className="field">
              <label htmlFor="bind-policy-number">
                Policy number (can be added later)
              </label>
              <Input
                id="bind-policy-number"
                value={policyNumber}
                disabled={saving}
                onChange={(e) => setPolicyNumber(e.target.value)}
              />
            </div>
          </div>
          {billType === "DIRECT" && (
            <p className="small muted">
              The carrier bills the association and pays us commission
              afterwards.
            </p>
          )}
          {billType && (
            <div className="card" aria-label="Carrier commission payment arrangement">
              {paymentPreview.loading && <p className="small muted">Loading carrier payment terms…</p>}
              {paymentPreview.error && <p role="alert">{paymentPreview.error}</p>}
              {paymentPreview.data && !paymentPreview.loading && !paymentPreview.error && (
                <>
                  <p><strong>{COMMISSION_BASES[paymentPreview.data.basis]}</strong></p>
                  {paymentPreview.data.payment ? (
                    <>
                      <p className="small">
                        Payor: {paymentPreview.data.payment.payor}. Remittance: {({ ONCE: 'once', MONTHLY: 'monthly', QUARTERLY: 'quarterly' })[paymentPreview.data.payment.cadence]}.
                        {' '}Trigger: {({ BIND: 'bind date', EFFECTIVE: 'policy effective date', COLLECTION: 'premium collection', EARNED: 'coverage provided' })[paymentPreview.data.payment.trigger]}.
                        {' '}Calendar-day lag: {paymentPreview.data.payment.lagDays}.
                        {paymentPreview.data.payment.cutoffDay !== undefined && ` Statement cutoff day: ${paymentPreview.data.payment.cutoffDay} (clamped to month end).`}
                        {paymentPreview.data.payment.paymentDay !== undefined && ` Payment day: ${paymentPreview.data.payment.paymentDay} (clamped to month end).`}
                      </p>
                      {paymentPreview.data.basis === 'COLLECTED' && <p className="small muted">Expected receipt amounts require collection information or an Owner-entered schedule.</p>}
                      <label><Input type="checkbox" checked={paymentConfirmation === paymentKey} disabled={saving} onChange={e => setPaymentConfirmation(e.target.checked ? paymentKey : '')} /> I reviewed the carrier commission payment arrangement.</label>
                    </>
                  ) : <p className="small muted">Legacy carrier terms: receipt timing is unconfirmed. An Owner can add structured terms; producer earnings continue to follow actual receipts.</p>}
                </>
              )}
              <Button variant="secondary" type="button"  disabled={saving || paymentPreview.loading} onClick={() => { setPaymentConfirmation(''); void paymentPreview.refetch(); }}>Refresh carrier payment terms</Button>
            </div>
          )}
          <label><Input type="checkbox" checked={confirmed} disabled={saving} onChange={e => setConfirmed(e.target.checked)} /> I confirmed the exact premium and agency commission percentage.</label>
          <div className="form-actions quote-flow-actions">
            <Button variant="primary"

              disabled={saving || !billType || (hasBrokerFee && billType !== "AGENCY") || !confirmed || !paymentReady || !premium || !agencyRate}
              onClick={bind}
            >
              {saving ? "Binding…" : "Confirm bind"}
            </Button>
            <Button variant="secondary"  disabled={saving} onClick={() => onDone(null)}>
              Cancel
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
