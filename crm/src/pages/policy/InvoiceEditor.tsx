import { useCallback, useState } from "react";
import { client, type Invoice, type InvoiceLine, type Policy } from "../../lib/client";
import { listAllPages } from "../../lib/pagination";
import { useAsyncResource } from "../../lib/useAsyncResource";
import { SaveStatus, useSaveStatus } from "../../components/SaveStatus";
import ConfirmButton from "../../components/ConfirmButton";
import {
  formatMoney,
  invoiceTotals,
  marginWarnings,
  premiumLineFromPolicy,
} from "../../lib/invoiceTotals";

/**
 * One invoice: its lines, what they cost us, and the button that emails it.
 *
 * ── Cost is on this screen and on no other ──────────────────────────────────
 * The cost column is the point of the whole feature and is also the one thing
 * that must never reach the insured. It lives here, in the CRM, behind a login;
 * `send-invoice/invoice.ts` renders retail only and has a test saying so.
 *
 * ── Totals are recomputed, never read ───────────────────────────────────────
 * Every figure below comes from `invoiceTotals` over the current rows, the same
 * function the send Lambda runs server-side. There is no stored total to
 * disagree with, so the screen and the email cannot say different numbers.
 */

const LINE_KINDS = [
  ["PREMIUM", "Premium"],
  ["ENDORSEMENT", "Endorsement"],
  ["TAX", "Tax"],
  ["SURPLUS_LINES", "Surplus lines"],
  ["STAMPING_FEE", "Stamping fee"],
  ["OTHER", "Other"],
] as const;

/** `12480.5` → `"12480.50"` for an input, `null` → `""`. */
const toInput = (n: number | null | undefined): string =>
  typeof n === "number" && Number.isFinite(n) ? String(n) : "";

/** `""` → null, so a cleared box is "unknown" rather than a confident zero. */
const fromInput = (v: string): number | null => {
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

export function InvoiceEditor({
  invoice,
  policy,
  onChange,
  onDeleted,
}: {
  invoice: Invoice;
  policy: Policy | null;
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
      description: `${(policy.lines ?? []).join(", ") || "Premium"}`.trim(),
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

  if (!linesRes.loaded) return <p className="muted">Loading invoice…</p>;
  if (linesRes.error) return <p className="error-text">{linesRes.error}</p>;

  return (
    <div className="card">
      <div className="row-between">
        <h2>
          {invoice.number ?? "Invoice"}{" "}
          <span className={`badge badge--${(invoice.status ?? "DRAFT").toLowerCase()}`}>
            {invoice.status}
          </span>
        </h2>
        <SaveStatus {...saveStatus.status} />
      </div>

      <div className="grid-2">
        <div className="field">
          <label htmlFor={`inv-issued-${invoice.id}`}>Issued</label>
          <input
            id={`inv-issued-${invoice.id}`}
            type="date"
            defaultValue={invoice.issuedAt ?? ""}
            disabled={locked}
            onBlur={(e) => void patchInvoice({ issuedAt: e.target.value || null })}
          />
        </div>
        <div className="field">
          <label htmlFor={`inv-due-${invoice.id}`}>Due</label>
          <input
            id={`inv-due-${invoice.id}`}
            type="date"
            defaultValue={invoice.dueAt ?? ""}
            disabled={locked}
            onBlur={(e) => void patchInvoice({ dueAt: e.target.value || null })}
          />
        </div>
      </div>

      <div className="field">
        <label htmlFor={`inv-pay-${invoice.id}`}>Payment link</label>
        <input
          id={`inv-pay-${invoice.id}`}
          type="url"
          placeholder="Paste the link from your payment processor"
          defaultValue={invoice.paymentUrl ?? ""}
          disabled={locked}
          onBlur={(e) => void patchInvoice({ paymentUrl: e.target.value.trim() || null })}
        />
        <p className="hint">
          Leave blank and sending generates a Stripe link for bank transfer,
          which costs $5 whatever the premium. Paste your own to override it.
        </p>
      </div>

      <div className="field">
        <label htmlFor={`inv-memo-${invoice.id}`}>Memo</label>
        <textarea
          id={`inv-memo-${invoice.id}`}
          rows={2}
          placeholder="Shown to the insured, above the total."
          defaultValue={invoice.memo ?? ""}
          disabled={locked}
          onBlur={(e) => void patchInvoice({ memo: e.target.value.trim() || null })}
        />
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>Description</th>
            <th>Kind</th>
            <th className="num">Bills (retail)</th>
            <th className="num">Costs us</th>
            <th className="num">Margin</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const margin =
              (l.retailAmount ?? 0) - (l.costAmount ?? 0);
            return (
              <tr key={l.id}>
                <td>
                  <input
                    aria-label="Description"
                    defaultValue={l.description ?? ""}
                    disabled={locked}
                    onBlur={(e) =>
                      void patchLine(l.id, { description: e.target.value })
                    }
                  />
                </td>
                <td>
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
                    type="number"
                    step="0.01"
                    defaultValue={toInput(l.retailAmount)}
                    disabled={locked}
                    onBlur={(e) =>
                      void patchLine(l.id, { retailAmount: fromInput(e.target.value) })
                    }
                  />
                </td>
                <td className="num">
                  <input
                    aria-label="Costs the agency"
                    type="number"
                    step="0.01"
                    defaultValue={toInput(l.costAmount)}
                    disabled={locked}
                    onBlur={(e) =>
                      void patchLine(l.id, { costAmount: fromInput(e.target.value) })
                    }
                  />
                </td>
                <td className="num muted">{formatMoney(margin)}</td>
                <td>
                  {!locked && (
                    <ConfirmButton
                      label="Remove"
                      busyLabel="Removing…"
                      className="link-danger"
                      onConfirm={() => removeLine(l.id)}
                    />
                  )}
                </td>
              </tr>
            );
          })}
          {lines.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                No lines yet.
              </td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr>
            <th colSpan={2}>Total</th>
            <th className="num">{formatMoney(totals.retail)}</th>
            <th className="num">{formatMoney(totals.cost)}</th>
            <th className="num">
              {formatMoney(totals.margin)}
              {totals.marginPct !== null && (
                <span className="muted"> ({totals.marginPct}%)</span>
              )}
            </th>
            <th />
          </tr>
        </tfoot>
      </table>

      {!locked && (
        <div className="row-gap">
          <button type="button" onClick={() => void addLine()}>
            Add line
          </button>
          {policy && (
            <button type="button" onClick={() => void addPremiumFromPolicy()}>
              Add premium from policy
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

      {!locked && (
        <div className="card card--inset">
          <h3>Send</h3>
          <div className="field">
            <label htmlFor={`inv-to-${invoice.id}`}>To</label>
            <input
              id={`inv-to-${invoice.id}`}
              type="email"
              placeholder="Leave blank to use the account's primary contact"
              value={toEmail}
              onChange={(e) => setToEmail(e.target.value)}
            />
            <p className="hint">
              The agency is copied on every invoice, so a sent copy is findable
              without opening the CRM.
            </p>
          </div>
          <div className="row-gap">
            <button
              type="button"
              className="btn-primary"
              disabled={sendStatus.busy || lines.length === 0}
              onClick={() => void send()}
            >
              {invoice.sentAt ? "Send again" : "Send invoice"}
            </button>
            <SaveStatus {...sendStatus.status} />
          </div>
          {invoice.sentAt && (
            <p className="hint">
              Last sent {new Date(invoice.sentAt).toLocaleString()}
              {invoice.sentTo ? ` to ${invoice.sentTo}` : ""}.
            </p>
          )}
        </div>
      )}

      <div className="row-gap">
        {(invoice.status === "SENT" || invoice.status === "PROCESSING") && (
          <button
            type="button"
            onClick={() =>
              void patchInvoice(
                { status: "PAID", paidAt: new Date().toISOString().slice(0, 10) },
                "Marked paid."
              )
            }
          >
            Mark paid
          </button>
        )}
        {invoice.status === "PROCESSING" && (
          <p className="hint">
            A bank transfer has been authorised and is clearing. Stripe will mark
            this paid when the money lands; the button is here for a cheque that
            arrived another way.
          </p>
        )}
        {!locked && (
          <ConfirmButton
            label="Void"
            busyLabel="Voiding…"
            className="link-danger"
            // Voided, not deleted: the number must never be reused, and a gap in
            // the sequence is explainable in a way a reissue is not.
            message="The number is retired, not reused."
            onConfirm={() => patchInvoice({ status: "VOID" }, "Voided.")}
          />
        )}
        {locked && lines.length === 0 && (
          <ConfirmButton
            label="Delete"
            busyLabel="Deleting…"
            className="link-danger"
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
  );
}

export default InvoiceEditor;
