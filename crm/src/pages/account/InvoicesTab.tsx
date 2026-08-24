import { useState } from "react";
import {
  client,
  fmtDate,
  fmtMoney,
  listAllPages,
  type Account,
  type Contact,
  type Invoice,
  type InvoiceLine,
  type Policy,
  type Quote,
} from "../../lib/client";
import { useAsyncResource } from "../../lib/useAsyncResource";
import { SaveStatus, useSaveStatus } from "../../components/SaveStatus";
import { InvoiceEditor } from "../../components/InvoiceEditor";
import { invoiceTotals, premiumLineFromPolicy } from "../../lib/invoiceTotals";
import {
  invoiceableQuotes,
  liveAnchorIds,
  seededLineDescription,
  seededQuoteLineDescription,
  unbilledAgencyPolicies,
} from "../../lib/invoiceSeed";
import { isOpenQuoteStatus } from "../../lib/quoteStatus";
import { Badge, INVOICE_STATUS_BADGE, statusBadge } from "../../lib/badges";

/**
 * Everything this association has been billed.
 *
 * ## Why the account and not the policy
 *
 * Billing first lived on a policy page, because an invoice usually bills a
 * policy. But `Invoice.accountId` is required and `policyId` is not — a fee, a
 * cancellation adjustment, or a bill spanning two policies has no single policy
 * to sit under, and those had nowhere to be created at all. Worse, the account
 * is the thing a producer actually opens: answering "what does this association
 * owe us" meant opening each policy in turn and holding the answer in your head.
 *
 * ## One row each, opened on request
 *
 * Every invoice used to render its whole editor, so an account with six of them
 * was six stacked tables and six Send blocks — several screens of controls for
 * records that are finished and are only being looked up. The table answers the
 * lookup; expanding answers the edit.
 */

/** ISO day, `days` from the given ISO day. */
export function addDays(isoDay: string, days: number): string {
  // Parsed as UTC and shifted in whole days, so a machine west of Greenwich
  // cannot land the result on the day before the one it printed.
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** How long an association gets to pay, unless a producer changes it. */
export const DEFAULT_TERM_DAYS = 14;

export function InvoicesTab({ accountId }: { accountId: string }) {
  const res = useAsyncResource(
    async () => {
      /**
       * Invoices, their lines, the policies and the contacts, together.
       *
       * The lines are needed by the table — every total on it is computed from
       * them, since no total is stored — and by the seeding rule, which has to
       * know which policies are already billed. Fetching them per-invoice would
       * be one round trip per row to render a summary.
       */
      const [invoices, lines, policies, quotes, contacts, account] = await Promise.all([
        listAllPages((nextToken) =>
          client.models.Invoice.list({
            filter: { accountId: { eq: accountId } },
            nextToken,
          })
        ),
        listAllPages((nextToken) =>
          client.models.InvoiceLine.list({
            filter: { accountId: { eq: accountId } },
            nextToken,
          })
        ),
        listAllPages((nextToken) =>
          client.models.Policy.list({
            filter: { accountId: { eq: accountId } },
            nextToken,
          })
        ),
        // W8: quotes are invoiceable before bind — premium billed, financing
        // offered, everything rolling onto the policy at bind.
        listAllPages((nextToken) =>
          client.models.Quote.list({
            filter: { accountId: { eq: accountId } },
            nextToken,
          })
        ),
        listAllPages((nextToken) =>
          client.models.Contact.list({
            filter: { accountId: { eq: accountId } },
            nextToken,
          })
        ),
        // The financing hint predicts the send's origination, which reads
        // the account's state, type and incorporation.
        client.models.Account.get({ id: accountId }).then((r) => r.data),
      ]);
      return {
        invoices: invoices as Invoice[],
        lines: lines as InvoiceLine[],
        policies: policies as Policy[],
        quotes: quotes as Quote[],
        contacts: contacts as Contact[],
        account: account as Account | null,
      };
    },
    [accountId],
    { initialData: null, errorMessage: "Failed to load invoices" }
  );

  const createStatus = useSaveStatus();
  const [openId, setOpenId] = useState<string | null>(null);
  /** "policy:<id>" | "quote:<id>" — the anchor the next invoice bills. */
  const [anchorKey, setAnchorKey] = useState("");

  /**
   * W8: every invoice bills exactly one policy or quote, chosen HERE, and an
   * anchor carries one live invoice at a time — PAID and VOID free the slot
   * for endorsement and audit billing. The picker below simply doesn't offer
   * a busy anchor; the send Lambda enforces the same rule again.
   */
  async function newInvoice() {
    const loaded = res.data;
    if (!loaded || !anchorKey) return;
    const [kind, anchorId] = anchorKey.split(":", 2);
    await createStatus.run(
      async () => {
        /**
         * The number is reserved before the row exists, so two producers
         * clicking at once cannot collide. If the create then fails the number
         * is spent and the sequence has a gap — the trade this scheme makes
         * deliberately: gaps are explainable, reuse is not.
         */
        const reserved = await client.mutations.reserveInvoiceNumber();
        const raw = reserved.data;
        const parsed =
          typeof raw === "string" ? JSON.parse(raw) : (raw as Record<string, unknown>);
        const number =
          typeof parsed?.invoiceNumber === "string" ? parsed.invoiceNumber : null;

        const today = new Date().toISOString().slice(0, 10);
        const { data, errors } = await client.models.Invoice.create({
          accountId,
          number,
          status: "DRAFT",
          issuedAt: today,
          dueAt: addDays(today, DEFAULT_TERM_DAYS),
          ...(kind === "policy" ? { policyId: anchorId } : { quoteId: anchorId }),
        });
        if (errors?.length || !data) throw new Error(errors?.[0]?.message);

        // One anchor, one seeded premium line: the number the record actually
        // knows is the cost; what to bill for it stays the producer's call.
        const policy = kind === "policy" ? loaded.policies.find((p) => p.id === anchorId) : null;
        const quote = kind === "quote" ? loaded.quotes.find((q) => q.id === anchorId) : null;
        const source = policy ?? quote;
        const created: InvoiceLine[] = [];
        if (source) {
          const { retailAmount, costAmount } = premiumLineFromPolicy(source);
          const line = await client.models.InvoiceLine.create({
            invoiceId: data.id,
            accountId,
            ...(policy ? { policyId: policy.id } : {}),
            kind: "PREMIUM",
            description: policy
              ? seededLineDescription(policy)
              : seededQuoteLineDescription(quote!),
            sortOrder: 0,
            retailAmount,
            costAmount,
          });
          if (line.data) created.push(line.data);
        }

        res.setData((cur) =>
          cur
            ? {
                ...cur,
                invoices: [data, ...cur.invoices],
                lines: [...cur.lines, ...created],
              }
            : cur
        );
        setAnchorKey("");
        // Straight into the one just made — it is the only reason to press it.
        setOpenId(data.id);
        return "Invoice created — price the premium line.";
      },
      { errorMessage: "Couldn't create an invoice." }
    );
  }

  if (!res.loaded) return <p className="muted small">Loading…</p>;
  if (res.error) return <p className="error-text">{res.error}</p>;
  if (!res.data) return null;

  const { invoices, lines, policies, quotes, contacts, account } = res.data;
  // Newest first: the one someone came here for is almost always the last made.
  const ordered = [...invoices].sort((a, b) =>
    (b.createdAt ?? "").localeCompare(a.createdAt ?? "")
  );
  const open = ordered.find((i) => i.id === openId) ?? null;

  // PAID and VOID free the slot — voiding a bill is how a policy gets
  // billed again. The rule itself is the pure module's, with its tests.
  const busyAnchors = liveAnchorIds(invoices, lines);
  const openPolicies = unbilledAgencyPolicies(policies, busyAnchors);
  const openQuotes = invoiceableQuotes(quotes, busyAnchors, isOpenQuoteStatus);

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2>Invoices</h2>
          <div className="inline-actions">
            <SaveStatus {...createStatus.status} />
            <select
              aria-label="Bill which policy or quote"
              value={anchorKey}
              onChange={(e) => setAnchorKey(e.target.value)}
            >
              <option value="">Bill which policy or quote…</option>
              {openPolicies.map((p) => (
                <option key={p.id} value={`policy:${p.id}`}>
                  {p.policyNumber?.trim() ||
                    (p.lines ?? []).filter(Boolean).join(", ") ||
                    "Policy"}
                  {p.effectiveDate ? ` (${p.effectiveDate})` : ""}
                  {p.billType ? "" : " — bill type not recorded"}
                </option>
              ))}
              {openQuotes.map((q) => (
                <option key={q.id} value={`quote:${q.id}`}>
                  Quote — {(q.lines ?? []).filter(Boolean).join(", ") || "coverage"}
                  {q.effectiveDate ? ` (${q.effectiveDate})` : ""}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="primary"
              disabled={createStatus.busy || !anchorKey}
              onClick={() => void newInvoice()}
            >
              New invoice
            </button>
          </div>
        </div>
        {openPolicies.length === 0 && openQuotes.length === 0 && (
          <p className="muted small">
            Every policy and open quote either has a live invoice already or
            isn't agency-billed. One live invoice per policy or quote — void
            or collect the existing one to bill again.
          </p>
        )}

        {ordered.length === 0 ? (
          <p className="muted small">
            Nothing billed yet. Choose the policy or quote to bill — the
            invoice opens with its premium line ready to price.
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Issued</th>
                  <th>Due</th>
                  <th>Status</th>
                  <th className="num">Total</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {ordered.map((inv) => {
                  const own = lines.filter((l) => l.invoiceId === inv.id);
                  const isOpen = inv.id === openId;
                  return (
                    <tr key={inv.id} className={isOpen ? "row-open" : undefined}>
                      <td>{inv.number ?? "—"}</td>
                      <td>{fmtDate(inv.issuedAt)}</td>
                      <td>{fmtDate(inv.dueAt)}</td>
                      <td>
                        <Badge {...statusBadge(INVOICE_STATUS_BADGE, inv.status)} />
                      </td>
                      <td className="num">
                        {fmtMoney(invoiceTotals(own).retail)}
                      </td>
                      <td className="row-action">
                        <button
                          type="button"
                          className="link"
                          aria-expanded={isOpen}
                          onClick={() => setOpenId(isOpen ? null : inv.id)}
                        >
                          {isOpen ? "Close" : "Open"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {open && (
        <InvoiceEditor
          // Keyed, so opening a different invoice remounts rather than carrying
          // the previous one's unsaved input across.
          key={open.id}
          invoice={open}
          policies={policies}
          quotes={quotes}
          account={account}
          contacts={contacts}
          onChange={(next) =>
            res.setData((cur) =>
              cur
                ? {
                    ...cur,
                    invoices: cur.invoices.map((i) => (i.id === next.id ? next : i)),
                  }
                : cur
            )
          }
          onLinesChange={(invoiceId, next) =>
            res.setData((cur) =>
              cur
                ? {
                    ...cur,
                    lines: [
                      ...cur.lines.filter((l) => l.invoiceId !== invoiceId),
                      ...next,
                    ],
                  }
                : cur
            )
          }
          onDeleted={() => {
            setOpenId(null);
            res.setData((cur) =>
              cur
                ? { ...cur, invoices: cur.invoices.filter((i) => i.id !== open.id) }
                : cur
            );
          }}
        />
      )}
    </>
  );
}

export default InvoicesTab;
