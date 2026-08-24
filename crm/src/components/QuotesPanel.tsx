import { useState } from "react";
import {
  client,
  fmtDate,
  fmtMoney,
  friendlyError,
  listAllPages,
  type Account,
  type Carrier,
  type Quote,
} from "../lib/client";
import { Badge, statusBadge, QUOTE_STATUS_BADGE } from "../lib/badges";
import { useAsyncResource } from "../lib/useAsyncResource";
import { useSort, SortTh } from "../lib/useSort";
import CoverageForm from "./CoverageForm";
import { SaveStatus, useSaveStatus } from "./SaveStatus";
import {
  isOpenQuoteStatus,
  SELECTABLE_QUOTE_STATUSES,
} from "../lib/quoteStatus";
import { BILL_TYPE_OPTIONS, type BillType } from "../lib/enums";
import { currentActor } from "../lib/client";

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
export default function QuotesPanel({
  account,
  onAccountChange,
}: {
  account: Account;
  onAccountChange: (a: Account) => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Quote | null>(null);
  const [binding, setBinding] = useState<Quote | null>(null);
  const [bindError, setBindError] = useState("");
  // Auto-clearing: the status change is made from a per-row <select> that
  // then re-renders with the new value, and an open quote that moves to
  // DECLINED/LOST leaves the table entirely — there is no form to go dirty
  // and retire the confirmation, so a timer is what retires it.
  const statusSave = useSaveStatus({ autoClearMs: 4000 });

  const quoteRes = useAsyncResource(
    () =>
      listAllPages((nextToken) =>
        client.models.Quote.list({
          filter: { accountId: { eq: account.id } },
          nextToken,
        })
      ),
    [account.id],
    { initialData: [] as Quote[], errorMessage: "Failed to load quotes" }
  );
  const quotes = quoteRes.data;
  // Identity-stable, so passing it to CoverageForm/BindForm no longer
  // re-renders them on every render of this panel.
  const refresh = quoteRes.refetch;

  // Carriers are agency-wide, not account-scoped, so they are their own
  // resource on their own (empty) deps: refreshing the quotes after a status
  // change or a bind must not re-read the whole carrier table, and switching
  // accounts must not blank the carrier names while it re-reads.
  const carrierRes = useAsyncResource(
    async () => (await client.models.Carrier.list()).data,
    [],
    { initialData: [] as Carrier[] }
  );
  const carrierRows = carrierRes.data;

  async function setStatus(quote: Quote, status: Quote["status"]) {
    await statusSave.run(
      async () => {
        // `errors` used to be dropped: the refetch quietly restored the old
        // value and the user was told nothing.
        const { errors } = await client.models.Quote.update({
          id: quote.id,
          status,
        });
        if (errors?.length) throw new Error(errors[0].message);
        refresh();
      },
      {
        savedMessage: `Quote set to ${status}.`,
        errorMessage: "Couldn't change that quote's status.",
      }
    );
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
      status: (q) => q.status,
      created: (q) => q.createdAt,
    },
    "created",
    "desc"
  );

  return (
    <div>
      <div className="toolbar">
        {/* Per-row status changes have no per-row place to report; this is
            the panel's one status line. */}
        <SaveStatus {...statusSave.status} />
        <div className="grow" />
        <button
          className="primary"
          onClick={() => {
            setEditing(null);
            setShowForm(!showForm);
          }}
        >
          {showForm ? "Cancel" : "+ New quote"}
        </button>
      </div>

      {(showForm || editing) && (
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
      )}

      {/* Surfaced rather than ignored: without carriers every row's first
          column reads "—", which is indistinguishable from quotes genuinely
          having no carrier set. */}
      {carrierRes.error && <p className="error-text">{carrierRes.error}</p>}

      {quoteRes.error ? (
        <p className="error-text">{quoteRes.error}</p>
      ) : quotes.length === 0 ? (
        <p className="muted small">No quotes yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <SortTh label="Carrier" colKey="carrier" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <SortTh label="Lines" colKey="lines" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <SortTh label="Premium" colKey="premium" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <SortTh label="Commission" colKey="commission" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <th>Terms</th>
                <SortTh label="Effective" colKey="effective" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <SortTh label="Status" colKey="status" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((qt) => (
                <tr key={qt.id}>
                  <td>{carrierName(qt.carrierId)}</td>
                  <td className="small">{(qt.lines ?? []).filter(Boolean).join(", ") || "—"}</td>
                  <td>{fmtMoney(qt.premium)}</td>
                  <td className="small">{commissionCell(qt)}</td>
                  <td className="small">{termsSummary(qt)}</td>
                  <td>{fmtDate(qt.effectiveDate)}</td>
                  <td>
                    <Badge {...statusBadge(QUOTE_STATUS_BADGE, qt.status)} />
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button
                      className="link"
                      onClick={() => {
                        setShowForm(false);
                        setEditing(qt);
                      }}
                    >
                      Edit
                    </button>
                    {isOpenQuoteStatus(qt.status) && (
                      <>
                        <select
                          className="small"
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
                        </select>{" "}
                        <button className="link" onClick={() => setBinding(qt)}>
                          Bind
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {binding && (
        <BindForm
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
      {bindError && <p className="error-text">{bindError}</p>}
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
  /**
   * No default. Bill type decides whether anyone here is supposed to collect
   * the premium, and a pre-selected answer to that is one nobody reads — the
   * first policy silently marked agency bill when the carrier is billing the
   * association directly is an invoice sent for money already paid.
   */
  const [billType, setBillType] = useState<BillType | "">("");
  /**
   * Seeded from the quote's own recorded answer when one exists (W8 put
   * the question on the quote), defaulting checked otherwise — acceptable
   * ONLY because true holds for every policy bound from our own quote, and
   * because the value is stamped with who submitted it and when, which
   * turns a default into an affirmation. A quote explicitly recorded as
   * NOT ours must not become POR-attested by an unexamined click. Import
   * and bulk paths get no pre-check and no checkbox at all: their policies
   * start null and financing blocks until a person confirms on the policy
   * record. (Signed decision 4, 2026-08-21.)
   */
  const [producerOfRecord, setProducerOfRecord] = useState(quote.producerOfRecord ?? true);
  const [saving, setSaving] = useState(false);

  // A quote must carry real terms before it can become a policy.
  const blockers = [
    !quote.carrierId && "a carrier",
    !(quote.premium && quote.premium > 0) && "a premium",
    !quote.effectiveDate && "an effective date",
    !(quote.lines ?? []).filter(Boolean).length && "at least one line",
  ].filter(Boolean) as string[];

  async function bind() {
    // Belt and braces: the button is disabled without one, but `bind` is the
    // thing that writes the row and an unset bill type must never reach it.
    if (!billType) return;
    setSaving(true);
    onError("");
    try {
      /**
       * 0. One policy per quote, checked before anything is written. The
       * schema's hasOne is a query convenience, not a constraint — and a
       * stale panel (another producer bound seconds ago, or a prior bind
       * whose status write silently failed) is exactly when this button
       * gets clicked again.
       */
      const { data: freshQuote, errors: fqErr } = await client.models.Quote.get({
        id: quote.id,
      });
      if (fqErr?.length) throw new Error(fqErr[0].message);
      if (!freshQuote || !isOpenQuoteStatus(freshQuote.status)) {
        throw new Error(
          "This quote is no longer open — it may already be bound. Refresh and check the policies list."
        );
      }
      const { data: priorPolicies, errors: ppErr } = await client.models.Policy.list({
        filter: { quoteId: { eq: quote.id } },
      });
      if (ppErr?.length) throw new Error(ppErr[0].message);
      if (priorPolicies?.length) {
        throw new Error(
          `This quote is already bound to policy ${priorPolicies[0].policyNumber ?? priorPolicies[0].id}. Binding it twice would bill one premium twice.`
        );
      }

      // 1. Policy from the accepted quote (terms + commission carry over)
      const { data: policy, errors: pErr } = await client.models.Policy.create({
        accountId: account.id,
        quoteId: quote.id,
        carrierId: quote.carrierId ?? undefined,
        policyNumber: policyNumber.trim() || undefined,
        status: "ACTIVE",
        billType,
        producerOfRecord,
        ...(producerOfRecord
          ? {
              producerOfRecordBy: (await currentActor()) ?? "unknown",
              producerOfRecordAt: new Date().toISOString(),
            }
          : {}),
        lines: (quote.lines ?? []).filter((l): l is string => !!l),
        premium: quote.premium ?? undefined,
        commissionPct: quote.commissionPct ?? undefined,
        // Limits are what print on the COI — they must survive the bind.
        glEachOccurrence: quote.glEachOccurrence ?? undefined,
        glDamageToRentedPremises: quote.glDamageToRentedPremises ?? undefined,
        glMedicalExpense: quote.glMedicalExpense ?? undefined,
        glPersonalAdvInjury: quote.glPersonalAdvInjury ?? undefined,
        glGeneralAggregate: quote.glGeneralAggregate ?? undefined,
        glProductsCompletedOps: quote.glProductsCompletedOps ?? undefined,
        glClaimsMade: quote.glClaimsMade ?? undefined,
        glAggregateAppliesTo: quote.glAggregateAppliesTo ?? undefined,
        perOccurrenceDeductible: quote.perOccurrenceDeductible ?? undefined,
        perUnitDeductible: quote.perUnitDeductible ?? undefined,
        blanketLimit: quote.blanketLimit ?? undefined,
        coinsurancePct: quote.coinsurancePct ?? undefined,
        replacementCostType: quote.replacementCostType ?? undefined,
        effectiveDate: quote.effectiveDate ?? undefined,
        expirationDate: quote.expirationDate ?? undefined,
        // W8: the origination screens answered on the quote survive the
        // bind — re-answering facts already recorded invites a different
        // answer. MEP rides along as underwriting data.
        isAuditable: quote.isAuditable ?? undefined,
        minimumEarnedPremiumPct: quote.minimumEarnedPremiumPct ?? undefined,
      });
      if (pErr?.length || !policy) throw new Error(pErr?.[0]?.message);

      // 2. Mark the quote bound. The Amplify client reports GraphQL errors
      // without throwing — a silent failure here leaves an ACTIVE policy on
      // a still-open quote, with Bind clickable for a second policy.
      {
        const { errors: bErr } = await client.models.Quote.update({
          id: quote.id,
          status: "BOUND",
        });
        if (bErr?.length) throw new Error(bErr[0].message);
      }

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
            const { data, errors } = await client.mutations.servicePfLoan({
              loanId: loan.id,
              action: "BIND_ROLLOVER",
              policyId: policy.id,
            });
            if (errors?.length) throw new Error(errors[0].message);
            const result =
              typeof data === "string" ? JSON.parse(data) : (data as Record<string, unknown>);
            if (!result?.ok) throw new Error(String(result?.error ?? "Rollover refused."));
          } catch (err) {
            rollFailures.push(`loan ${loan.id.slice(0, 8)}: ${(err as Error).message}`);
          }
        }
      } catch (err) {
        rollFailures.push((err as Error).message);
      }
      if (rollFailures.length) {
        onError(
          `Policy bound, but some billing didn't roll onto it: ${rollFailures.join("; ")}. The Financing tab can re-run a stuck loan's rollover.`
        );
      }

      // 3. Convert the lead in place — the only path to CLIENT
      let updated: Account | null = null;
      if (account.stage === "LEAD") {
        const { data } = await client.models.Account.update({
          id: account.id,
          stage: "CLIENT",
          convertedAt: new Date().toISOString(),
        });
        updated = data;
      }
      onDone(updated);
    } catch (err) {
      onError(friendlyError(err, "Bind failed"));
      onDone(null);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card" style={{ background: "#f0f7ef", marginTop: 14 }}>
      <h3 style={{ marginTop: 0 }}>Bind quote</h3>
      <p className="small muted">
        Creates a policy{account.stage === "LEAD" ? " and converts this lead to a client" : ""}.
      </p>
      {blockers.length > 0 ? (
        <>
          <p className="error-text">
            This quote can't be bound yet — it needs {blockers.join(", ")}.
            Edit the quote details first.
          </p>
          <div className="form-actions">
            <button className="secondary" onClick={() => onDone(null)}>
              Close
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="bind-bill-type">Bill type (required)</label>
              <select
                id="bind-bill-type"
                value={billType}
                onChange={(e) => setBillType(e.target.value as BillType | "")}
              >
                <option value="">Choose…</option>
                {BILL_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="bind-policy-number">
                Policy number (can be added later)
              </label>
              <input
                id="bind-policy-number"
                value={policyNumber}
                onChange={(e) => setPolicyNumber(e.target.value)}
              />
            </div>
          </div>
          <div className="field">
            <label className="check-list" style={{ display: "block" }}>
              <label>
                <input
                  type="checkbox"
                  checked={producerOfRecord}
                  onChange={(e) => setProducerOfRecord(e.target.checked)}
                />
                <span>
                  We are the producer of record on this policy.
                  <span className="muted small">
                    This is what makes it financeable in-house — uncheck it for
                    wholesale paper or another agency's client, and financing
                    stays blocked.
                  </span>
                </span>
              </label>
            </label>
          </div>
          {billType === "DIRECT" && (
            <p className="small muted">
              The carrier bills the association and pays us commission
              afterwards, so there is nothing to invoice from here.
            </p>
          )}
          <div className="form-actions">
            <button className="primary" disabled={saving || !billType} onClick={bind}>
              {saving ? "Binding…" : "Confirm bind"}
            </button>
            <button className="secondary" onClick={() => onDone(null)}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
