import { useCallback, useState } from "react";
import {
  client,
  type Contact,
  type Invoice,
  type InvoiceLine,
  type Policy,
} from "../lib/client";
import { listAllPages } from "../lib/pagination";
import { useAsyncResource } from "../lib/useAsyncResource";
import { SaveStatus, useSaveStatus } from "./SaveStatus";
import ConfirmButton from "./ConfirmButton";
import { Badge, INVOICE_STATUS_BADGE, statusBadge } from "../lib/badges";
import {
  directBillWarning,
  formatMoney,
  invoiceTotals,
  marginWarnings,
  premiumLineFromPolicy,
} from "../lib/invoiceTotals";

/**
 * One invoice: its lines, what they cost us, and the button that emails it.
 *
 * ── Cost is on this screen and on no other ──────────────────────────────────
 * The cost column is the point of the whole feature and is also the one thing
 * that must never reach the insured. It lives here, in the CRM, behind a login;
 * `send-invoice/invoice.ts` renders retail only and has a test saying so. The
 * table says which columns those are in a header spanning them, because a
 * producer reading a bill over the phone should never have to remember.
 *
 * ── Totals are recomputed, never read ───────────────────────────────────────
 * Every figure below comes from `invoiceTotals` over the current rows, the same
 * function the send Lambda runs server-side. There is no stored total to
 * disagree with, so the screen and the email cannot say different numbers.
 *
 * ── Order follows the job, not the record ───────────────────────────────────
 * Lines first, then dates, then send. The fields used to run in schema order —
 * issued, due, payment link, memo, and only then what was actually being
 * billed — which put four pieces of administrivia above the one question the
 * producer opened the invoice to answer. The payment link went with them: it is
 * generated automatically, so it belongs beside the send button as an override,
 * not at the top as a demand.
 */

const LINE_KINDS = [
  ["PREMIUM", "Premium"],
  ["ENDORSEMENT", "Endorsement"],
  ["TAX", "Tax"],
  ["SURPLUS_LINES", "Surplus lines"],
  ["STAMPING_FEE", "Stamping fee"],
  // All margin, and reported to accounting as its own kind of income rather
  // than as commission. Nothing charges it until in-house financing is offered.
  ["INTEREST", "Interest"],
  ["OTHER", "Other"],
] as const;

/** `12480.5` → `"12480.5"` for an input, `null` → `""`. */
const toInput = (n: number | null | undefined): string =>
  typeof n === "number" && Number.isFinite(n) ? String(n) : "";

/** `""` → null, so a cleared box is "unknown" rather than a confident zero. */
const fromInput = (v: string): number | null => {
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/** "POL-123 · Acme" for the policy picker, falling back to the dates. */
function policyLabel(p: Policy): string {
  const number = p.policyNumber?.trim();
  const lines = (p.lines ?? []).filter(Boolean).join(", ");
  const term = p.effectiveDate ? ` (${p.effectiveDate})` : "";
  return `${number || lines || "Policy"}${term}`;
}

export function InvoiceEditor({
  invoice,
  policies,
  contacts,
  onChange,
  onLinesChange,
  onDeleted,
}: {
  invoice: Invoice;
  /** The account's policies, so the invoice can say which one it bills. */
  policies: Policy[];
  /** The account's contacts — who the invoice can be addressed to. */
  contacts: Contact[];
  onChange: (next: Invoice) => void;
  /** Lifted so the summary table's totals move with the lines edited here. */
  onLinesChange: (invoiceId: string, lines: InvoiceLine[]) => void;
  onDeleted: () => void;
}) {
  const linesRes = useAsyncResource(
    () =>
      listAllPages((nextToken) =>
        client.models.InvoiceLine.list({
          filter: { invoiceId: { eq: invoice.id } },
          nextToken,
        })
      ),
    [invoice.id],
    { initialData: [] as InvoiceLine[], errorMessage: "Failed to load invoice lines" }
  );
  const lines = [...linesRes.data].sort(
    (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
  );

  const saveStatus = useSaveStatus({ autoClearMs: 4000 });
  const sendStatus = useSaveStatus();
  /**
   * Who it goes to, defaulting to the primary contact.
   *
   * Chosen from the account's contacts rather than typed. A free-text box
   * invites a typo into the one field where a mistake means the bill silently
   * never arrives — and every address worth using is already a Contact row.
   */
  const withEmail = contacts.filter((c) => (c.email ?? "").trim());
  const [toIds, setToIds] = useState<string[]>(() => {
    const primary = withEmail.find((c) => c.isPrimary) ?? withEmail[0];
    return primary ? [primary.id] : [];
  });
  const toEmails = toIds
    .map((id) => withEmail.find((c) => c.id === id)?.email?.trim())
    .filter((e): e is string => !!e);

  const totals = invoiceTotals(lines);
  const warnings = marginWarnings(lines);
  const locked = invoice.status === "VOID";
  const policy = policies.find((p) => p.id === invoice.policyId) ?? null;
  /**
   * Rendered at the policy picker rather than with the margin warnings above.
   * Those are about how the invoice is priced; this is about whether it should
   * exist, and the control that decides it is the picker.
   */
  const billWarning = directBillWarning(policy?.billType, lines);

  /**
   * One writer for the lines, so the summary table upstairs never disagrees
   * with the editor. Every mutation below goes through this rather than
   * `linesRes.setData`, which would update this component and nothing else.
   */
  const setLines = useCallback(
    (next: (ls: InvoiceLine[]) => InvoiceLine[]) => {
      linesRes.setData((ls) => {
        const updated = next(ls);
        onLinesChange(invoice.id, updated);
        return updated;
      });
    },
    [invoice.id, linesRes, onLinesChange]
  );

  const patchInvoice = useCallback(
    async (patch: Partial<Invoice>, savedMessage = "Saved.") => {
      await saveStatus.run(
        async () => {
          const { data, errors } = await client.models.Invoice.update({
            id: invoice.id,
            ...patch,
          });
          if (errors?.length || !data) throw new Error(errors?.[0]?.message);
          onChange(data);
        },
        { savedMessage, errorMessage: "Couldn't save that." }
      );
    },
    [invoice.id, onChange, saveStatus]
  );

  /**
   * Add a line, optionally directly below an existing one.
   *
   * `after` is the row the + was pressed on. Everything below it is pushed down
   * a place first, so the new row lands where the button is rather than at the
   * bottom of the table — which is the whole point of putting the control on
   * the row. The renumbering is fire-and-forget on the server and applied
   * locally either way: a `sortOrder` collision sorts by an arbitrary but
   * stable order, which is untidy, not wrong.
   */
  async function addLine(seed?: Partial<InvoiceLine>, after?: InvoiceLine) {
    const at = after ? (after.sortOrder ?? 0) + 1 : lines.length;
    if (after) {
      const below = lines.filter((l) => (l.sortOrder ?? 0) >= at);
      await Promise.all(
        below.map((l) =>
          client.models.InvoiceLine.update({
            id: l.id,
            sortOrder: (l.sortOrder ?? 0) + 1,
          })
        )
      );
      setLines((ls) =>
        ls.map((l) =>
          (l.sortOrder ?? 0) >= at ? { ...l, sortOrder: (l.sortOrder ?? 0) + 1 } : l
        )
      );
    }
    await saveStatus.run(
      async () => {
        const { data, errors } = await client.models.InvoiceLine.create({
          invoiceId: invoice.id,
          accountId: invoice.accountId,
          kind: "PREMIUM",
          description: "",
          sortOrder: at,
          ...seed,
        });
        if (errors?.length || !data) throw new Error(errors?.[0]?.message);
        setLines((ls) => [...ls, data]);
      },
      { savedMessage: "Line added.", errorMessage: "Couldn't add that line." }
    );
  }

  async function patchLine(id: string, patch: Partial<InvoiceLine>) {
    await saveStatus.run(
      async () => {
        const { data, errors } = await client.models.InvoiceLine.update({ id, ...patch });
        if (errors?.length || !data) throw new Error(errors?.[0]?.message);
        setLines((ls) => ls.map((l) => (l.id === id ? data : l)));
      },
      { errorMessage: "Couldn't save that line." }
    );
  }

  async function removeLine(id: string) {
    await saveStatus.run(
      async () => {
        const { errors } = await client.models.InvoiceLine.delete({ id });
        if (errors?.length) throw new Error(errors[0].message);
        setLines((ls) => ls.filter((l) => l.id !== id));
      },
      { savedMessage: "Line removed.", errorMessage: "Couldn't remove that line." }
    );
  }

  /** Seed the premium line from the policy, so the common case is one click. */
  async function addPremiumFromPolicy() {
    if (!policy) return;
    const { retailAmount, costAmount } = premiumLineFromPolicy(policy);
    await addLine({
      kind: "PREMIUM",
      description: (policy.lines ?? []).filter(Boolean).join(", ") || "Premium",
      retailAmount,
      costAmount,
    });
  }

  /**
   * Void through the mutation, not by writing the status here.
   *
   * Setting `status` from the browser left the Stripe link live, so an
   * association working from the original email could still pay a bill the
   * agency had withdrawn — and the webhook ignores every event for a void
   * invoice, correctly, so the money would land in trust with nothing recording
   * it. Closing the link needs the secret key, so the whole operation moved
   * server-side; see `void-invoice/resource.ts`.
   */
  async function voidThis() {
    await saveStatus.run(
      async () => {
        const { data, errors } = await client.mutations.voidInvoice({
          invoiceId: invoice.id,
        });
        if (errors?.length) throw new Error(errors[0].message);
        // `a.json()` arrives as an AWSJSON string — see lib/aiExtraction.ts.
        const result =
          typeof data === "string" ? JSON.parse(data) : (data as Record<string, unknown>);
        if (!result?.ok) throw new Error(String(result?.error ?? "Void failed."));
        const fresh = await client.models.Invoice.get({ id: invoice.id });
        if (fresh.data) onChange(fresh.data);
      },
      { savedMessage: "Voided.", errorMessage: "Couldn't void that invoice." }
    );
  }

  async function send() {
    await sendStatus.run(
      async () => {
        const { data, errors } = await client.mutations.sendInvoice({
          invoiceId: invoice.id,
          // Always explicit now that the recipients are chosen rather than
          // typed. The Lambda still falls back to the primary contact when
          // this is absent, which is what a resend from anywhere else does.
          toEmail: toEmails.join(","),
        });
        if (errors?.length) throw new Error(errors[0].message);
        // `a.json()` arrives as an AWSJSON string — see lib/aiExtraction.ts for
        // the trap this is. Parsed here rather than trusted as an object.
        const result =
          typeof data === "string" ? JSON.parse(data) : (data as Record<string, unknown>);
        if (!result?.ok) throw new Error(String(result?.error ?? "Send failed."));
        const fresh = await client.models.Invoice.get({ id: invoice.id });
        if (fresh.data) onChange(fresh.data);
        return `Sent to ${result.sentTo}.`;
      },
      { errorMessage: "Couldn't send that invoice." }
    );
  }

  if (!linesRes.loaded) return <p className="muted small">Loading invoice…</p>;
  if (linesRes.error) return <p className="error-text">{linesRes.error}</p>;

  const inputId = (part: string) => `inv-${part}-${invoice.id}`;

  return (
    <div className="card invoice">
      <div className="card-head">
        <h2 className="invoice-title">
          {invoice.number ?? "Invoice"}
          <Badge {...statusBadge(INVOICE_STATUS_BADGE, invoice.status)} />
        </h2>
        <div className="inline-actions">
          <SaveStatus {...saveStatus.status} />
          {/* Voided, not deleted: the number must never be reused, and a gap in
              the sequence is explainable in a way a reissue is not. */}
          {!locked && (
            <ConfirmButton
              label="Void"
              busyLabel="Voiding…"
              className="danger"
              message="The number is retired, and the payment link is closed."
              onConfirm={() => voidThis()}
            />
          )}
          {locked && lines.length === 0 && (
            <ConfirmButton
              label="Delete"
              busyLabel="Deleting…"
              className="danger"
              message="It is void and has no lines."
              onConfirm={async () => {
                const { errors } = await client.models.Invoice.delete({ id: invoice.id });
                if (errors?.length) throw new Error(errors[0].message);
                onDeleted();
              }}
            />
          )}
        </div>
      </div>

      {/* ── What is being billed ───────────────────────────────────────── */}
      <div className="table-wrap">
        <table className="invoice-lines">
          <thead>
            {/* Two header rows so the split is visible without reading the
                column names: everything under "The association sees" is on the
                emailed invoice, everything under "Agency only" never is. */}
            <tr className="group-head">
              <th colSpan={3}>The association sees</th>
              <th colSpan={2} className="internal band-start">
                Agency only
              </th>
              <th />
            </tr>
            <tr>
              <th>Description</th>
              <th className="kind-col">Kind</th>
              <th className="num">Amount</th>
              <th className="num internal band-start">Costs us</th>
              <th className="num internal">Margin</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const retail = l.retailAmount ?? 0;
              const cost = l.costAmount ?? 0;
              /**
               * A cost with nothing billed against it has no margin yet — it
               * is unpriced, not loss-making. Rendering the arithmetic would
               * put a large red negative on every freshly seeded invoice,
               * which is alarming about a row whose amount box is simply still
               * empty. Same reasoning as `marginPct` being null on zero retail.
               */
              const margin = retail === 0 && cost > 0 ? null : retail - cost;
              return (
                <tr key={l.id}>
                  <td>
                    <input
                      aria-label="Description"
                      placeholder="What this line is for"
                      defaultValue={l.description ?? ""}
                      disabled={locked}
                      onBlur={(e) =>
                        void patchLine(l.id, { description: e.target.value })
                      }
                    />
                  </td>
                  <td className="kind-col">
                    <select
                      aria-label="Kind"
                      defaultValue={l.kind ?? "PREMIUM"}
                      disabled={locked}
                      onChange={(e) =>
                        void patchLine(l.id, {
                          kind: e.target.value as InvoiceLine["kind"],
                        })
                      }
                    >
                      {LINE_KINDS.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="num">
                    <input
                      aria-label="Bills the association"
                      className="money"
                      type="number"
                      step="0.01"
                      placeholder="0.00"
                      defaultValue={toInput(l.retailAmount)}
                      disabled={locked}
                      onBlur={(e) =>
                        void patchLine(l.id, { retailAmount: fromInput(e.target.value) })
                      }
                    />
                  </td>
                  <td className="num internal band-start">
                    <input
                      aria-label="Costs the agency"
                      className="money"
                      type="number"
                      step="0.01"
                      placeholder="0.00"
                      defaultValue={toInput(l.costAmount)}
                      disabled={locked}
                      onBlur={(e) =>
                        void patchLine(l.id, { costAmount: fromInput(e.target.value) })
                      }
                    />
                  </td>
                  <td className="num internal muted">
                    {margin === null ? "—" : formatMoney(margin)}
                  </td>
                  <td className="row-action">
                    {!locked && (
                      <div className="row-tools">
                        {/* On the row rather than under the table, so a line
                            lands where it is wanted instead of at the bottom
                            and needing to be dragged up. */}
                        <button
                          type="button"
                          className="icon-btn"
                          title="Add a line below this one"
                          aria-label="Add a line below this one"
                          onClick={() => void addLine(undefined, l)}
                        >
                          +
                        </button>
                        <ConfirmButton
                          label="Remove"
                          busyLabel="Removing…"
                          className="danger"
                          onConfirm={() => removeLine(l.id)}
                        />
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            {lines.length === 0 && (
              <tr>
                <td colSpan={6} className="muted small">
                  No lines yet. A new invoice normally opens with one per
                  unbilled policy; add one by hand with the button below.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={2}>Total</th>
              <th className="num total">{formatMoney(totals.retail)}</th>
              <th className="num internal band-start">{formatMoney(totals.cost)}</th>
              <th className="num internal">
                {totals.retail === 0 && totals.cost > 0 ? (
                  <span className="muted">—</span>
                ) : (
                  <>
                    {formatMoney(totals.margin)}
                    {totals.marginPct !== null && (
                      <span className="muted"> ({totals.marginPct}%)</span>
                    )}
                  </>
                )}
              </th>
              <th />
            </tr>
          </tfoot>
        </table>
      </div>

      {!locked && (
        <div className="inline-actions">
          {/* Every other row is added with its own +. This is the way in when
              there is no row to press one on, and the way to append. */}
          <button type="button" className="secondary" onClick={() => void addLine()}>
            {lines.length === 0 ? "Add line" : "Add line at the end"}
          </button>
          {policy && (
            <button
              type="button"
              className="secondary"
              onClick={() => void addPremiumFromPolicy()}
            >
              Add premium from {policyLabel(policy)}
            </button>
          )}
        </div>
      )}

      {warnings.length > 0 && (
        <ul className="warn-list">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      {/* ── Details ────────────────────────────────────────────────────── */}
      <div className="form-grid invoice-details">
        {/* Its own row. The warning below it is the loudest thing on this
            card and reads as four cramped lines in a third-width column. */}
        <div className="field full policy-field">
          <label htmlFor={inputId("policy")}>Bills which policy</label>
          <select
            id={inputId("policy")}
            value={invoice.policyId ?? ""}
            disabled={locked}
            onChange={(e) => void patchInvoice({ policyId: e.target.value || null })}
          >
            {/* An invoice does not have to bill a policy — a broker fee or a
                cancellation adjustment bills none. */}
            <option value="">None — bills the account</option>
            {policies.map((p) => (
              <option key={p.id} value={p.id}>
                {policyLabel(p)}
              </option>
            ))}
          </select>
          {/* Three states, deliberately. The warning is the loud one and only
              fires when premium is actually billed; the quiet notes state the
              arrangement so it is known *before* a line is added rather than
              after. A policy with no bill type recorded says nothing — it was
              bound before the field existed and has no answer to give. */}
          {billWarning ? (
            <p className="warn-inline">{billWarning}</p>
          ) : policy?.billType === "DIRECT" ? (
            <p className="muted small">
              Direct bill — the carrier collects the premium.
            </p>
          ) : policy?.billType === "AGENCY" ? (
            <p className="muted small">Agency bill — we collect and remit.</p>
          ) : null}
        </div>
        <div className="field">
          <label htmlFor={inputId("issued")}>Issued</label>
          <input
            id={inputId("issued")}
            type="date"
            defaultValue={invoice.issuedAt ?? ""}
            disabled={locked}
            onBlur={(e) => void patchInvoice({ issuedAt: e.target.value || null })}
          />
        </div>
        <div className="field">
          <label htmlFor={inputId("due")}>Due</label>
          <input
            id={inputId("due")}
            type="date"
            defaultValue={invoice.dueAt ?? ""}
            disabled={locked}
            onBlur={(e) => void patchInvoice({ dueAt: e.target.value || null })}
          />
        </div>
        <div className="field full">
          <label htmlFor={inputId("memo")}>Memo</label>
          <textarea
            id={inputId("memo")}
            rows={2}
            placeholder="Optional. Shown to the association above the total."
            defaultValue={invoice.memo ?? ""}
            disabled={locked}
            onBlur={(e) => void patchInvoice({ memo: e.target.value.trim() || null })}
          />
        </div>
      </div>

      {/* ── Send ───────────────────────────────────────────────────────── */}
      {!locked && (
        <div className="card inset">
          <h3>Send</h3>
          <div className="field">
            <label htmlFor={inputId("to")}>Send to</label>
            {withEmail.length === 0 ? (
              <p className="warn-inline">
                No contact on this account has an email address. Add one on the
                Overview tab before sending.
              </p>
            ) : (
              <>
                {/* A checkbox each rather than a multiple <select>: an invoice
                    usually goes to two or three people — a manager and a
                    treasurer — and a ctrl-click list hides who is selected
                    behind a scrollbar, on the one field where being wrong
                    means the bill silently never arrives. */}
                <ul className="check-list" id={inputId("to")}>
                  {withEmail.map((c) => (
                    <li key={c.id}>
                      <label>
                        <input
                          type="checkbox"
                          checked={toIds.includes(c.id)}
                          onChange={(e) =>
                            setToIds((ids) =>
                              e.target.checked
                                ? [...ids, c.id]
                                : ids.filter((id) => id !== c.id)
                            )
                          }
                        />
                        <span>
                          {c.name}
                          {c.isPrimary && <span className="badge gray">Primary</span>}
                          <span className="muted small">{c.email}</span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
          <p className="muted small">
            The agency is copied on every invoice, so a sent copy is findable
            without opening the CRM. A branded PDF is attached automatically,
            and a Stripe bank-transfer link is generated when it sends.
          </p>

          <div className="inline-actions">
            <button
              type="button"
              className="primary"
              disabled={sendStatus.busy || lines.length === 0 || toEmails.length === 0}
              onClick={() => void send()}
            >
              {invoice.sentAt ? "Send again" : "Send invoice"}
            </button>
            <SaveStatus {...sendStatus.status} />
          </div>
          {lines.length === 0 && (
            <p className="muted small">Add a line before sending.</p>
          )}
          {withEmail.length > 0 && toEmails.length === 0 && (
            <p className="muted small">Choose at least one recipient.</p>
          )}
          {invoice.sentAt && (
            <p className="muted small">
              Last sent {new Date(invoice.sentAt).toLocaleString()}
              {invoice.sentTo ? ` to ${invoice.sentTo}` : ""}.
            </p>
          )}
        </div>
      )}

      {(invoice.status === "SENT" || invoice.status === "PROCESSING") && (
        <div className="inline-actions">
          <button
            type="button"
            className="secondary"
            onClick={() =>
              void patchInvoice(
                { status: "PAID", paidAt: new Date().toISOString().slice(0, 10) },
                "Marked paid."
              )
            }
          >
            Mark paid
          </button>
          {invoice.status === "PROCESSING" && (
            <p className="muted small">
              A bank transfer has been authorised and is clearing. Stripe marks
              this paid when the money lands; the button is for a cheque that
              arrived another way.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default InvoiceEditor;
