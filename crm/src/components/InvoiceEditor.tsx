import { useCallback, useState } from "react";
import { client, type Invoice, type InvoiceLine, type Policy } from "../lib/client";
import { listAllPages } from "../lib/pagination";
import { useAsyncResource } from "../lib/useAsyncResource";
import { SaveStatus, useSaveStatus } from "./SaveStatus";
import ConfirmButton from "./ConfirmButton";
import {
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
  ["OTHER", "Other"],
] as const;

/** Status → the badge palette in styles.css. */
const STATUS_TONE: Record<string, string> = {
  DRAFT: "gray",
  SENT: "blue",
  PROCESSING: "amber",
  PAID: "green",
  VOID: "red",
};

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
  onChange,
  onDeleted,
}: {
  invoice: Invoice;
  /** The account's policies, so the invoice can say which one it bills. */
  policies: Policy[];
  onChange: (next: Invoice) => void;
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
  const [toEmail, setToEmail] = useState("");

  const totals = invoiceTotals(lines);
  const warnings = marginWarnings(lines);
  const locked = invoice.status === "VOID";
  const policy = policies.find((p) => p.id === invoice.policyId) ?? null;

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

  async function addLine(seed?: Partial<InvoiceLine>) {
    await saveStatus.run(
      async () => {
        const { data, errors } = await client.models.InvoiceLine.create({
          invoiceId: invoice.id,
          kind: "PREMIUM",
          description: "",
          sortOrder: lines.length,
          ...seed,
        });
        if (errors?.length || !data) throw new Error(errors?.[0]?.message);
        linesRes.setData((ls) => [...ls, data]);
      },
      { savedMessage: "Line added.", errorMessage: "Couldn't add that line." }
    );
  }

  async function patchLine(id: string, patch: Partial<InvoiceLine>) {
    await saveStatus.run(
      async () => {
        const { data, errors } = await client.models.InvoiceLine.update({ id, ...patch });
        if (errors?.length || !data) throw new Error(errors?.[0]?.message);
        linesRes.setData((ls) => ls.map((l) => (l.id === id ? data : l)));
      },
      { errorMessage: "Couldn't save that line." }
    );
  }

  async function removeLine(id: string) {
    await saveStatus.run(
      async () => {
        const { errors } = await client.models.InvoiceLine.delete({ id });
        if (errors?.length) throw new Error(errors[0].message);
        linesRes.setData((ls) => ls.filter((l) => l.id !== id));
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

  async function send() {
    await sendStatus.run(
      async () => {
        const { data, errors } = await client.mutations.sendInvoice({
          invoiceId: invoice.id,
          ...(toEmail.trim() ? { toEmail: toEmail.trim() } : {}),
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
          <span className={`badge ${STATUS_TONE[invoice.status ?? "DRAFT"] ?? "gray"}`}>
            {invoice.status}
          </span>
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
              message="The number is retired, not reused."
              onConfirm={() => patchInvoice({ status: "VOID" }, "Voided.")}
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
              const margin = (l.retailAmount ?? 0) - (l.costAmount ?? 0);
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
                  <td className="num internal muted">{formatMoney(margin)}</td>
                  <td className="row-action">
                    {!locked && (
                      <ConfirmButton
                        label="Remove"
                        busyLabel="Removing…"
                        className="danger"
                        onConfirm={() => removeLine(l.id)}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
            {lines.length === 0 && (
              <tr>
                <td colSpan={6} className="muted small">
                  No lines yet — add one, or pull the premium straight from the
                  policy.
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
                {formatMoney(totals.margin)}
                {totals.marginPct !== null && (
                  <span className="muted"> ({totals.marginPct}%)</span>
                )}
              </th>
              <th />
            </tr>
          </tfoot>
        </table>
      </div>

      {!locked && (
        <div className="inline-actions">
          <button type="button" className="secondary" onClick={() => void addLine()}>
            Add line
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
        <div className="field">
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
          <div className="form-grid">
            <div className="field">
              <label htmlFor={inputId("to")}>To</label>
              <input
                id={inputId("to")}
                type="email"
                placeholder="The account's primary contact"
                value={toEmail}
                onChange={(e) => setToEmail(e.target.value)}
              />
            </div>
          </div>
          <p className="muted small">
            The agency is copied on every invoice, so a sent copy is findable
            without opening the CRM. A branded PDF is attached automatically.
          </p>

          {/* Folded away because the default needs no attention: sending mints
              a Stripe link on its own. Open only when overriding it. */}
          <details className="tucked" open={Boolean(invoice.paymentUrl)}>
            <summary>
              Payment link
              <span className="muted small">
                {invoice.paymentUrl ? " — using your own link" : " — generated on send"}
              </span>
            </summary>
            <div className="field">
              <input
                id={inputId("pay")}
                type="url"
                aria-label="Payment link"
                placeholder="Paste a link to override the generated one"
                defaultValue={invoice.paymentUrl ?? ""}
                onBlur={(e) =>
                  void patchInvoice({ paymentUrl: e.target.value.trim() || null })
                }
              />
              <p className="muted small">
                Left blank, sending generates a Stripe bank-transfer link, which
                costs $5 whatever the premium.
              </p>
            </div>
          </details>

          <div className="inline-actions">
            <button
              type="button"
              className="primary"
              disabled={sendStatus.busy || lines.length === 0}
              onClick={() => void send()}
            >
              {invoice.sentAt ? "Send again" : "Send invoice"}
            </button>
            <SaveStatus {...sendStatus.status} />
          </div>
          {lines.length === 0 && (
            <p className="muted small">Add a line before sending.</p>
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
