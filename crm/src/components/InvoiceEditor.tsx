import { useEffect, useRef, useState } from "react";
import {
  client,
  type Account,
  type Contact,
  type Invoice,
  type InvoiceLine,
  type Policy,
  type Quote,
} from "../lib/client";
import { FinanceOfferHint } from "./FinanceOfferHint";
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

export function InvoiceEditor(props: Parameters<typeof InvoiceEditorContent>[0]) {
  return <InvoiceEditorContent key={props.invoice.id} {...props} />;
}

function InvoiceEditorContent({
  invoice,
  policies,
  quotes,
  account,
  contacts,
  onChange,
  onLinesChange,
  onDeleted,
  onBusyChange,
}: {
  invoice: Invoice;
  /** The account's policies, so the invoice can say which one it bills. */
  policies: Policy[];
  /** The account's quotes — a W8 invoice may bill one before bind. */
  quotes: Quote[];
  /** The account row: the financing hint reads its state and incorporation. */
  account: Account | null;
  /** The account's contacts — who the invoice can be addressed to. */
  contacts: Contact[];
  onChange: (next: Invoice) => void;
  /** Lifted so the summary table's totals move with the lines edited here. */
  onLinesChange: (invoiceId: string, lines: InvoiceLine[]) => void;
  onDeleted: () => void;
  onBusyChange?: (busy: boolean) => void;
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
  /**
   * W8: the anchor was chosen at creation and does not change here — the
   * one-live-per-anchor rule is enforced against it, and re-pointing a bill
   * mid-flight is how two invoices end up on one premium. Legacy invoices
   * with only line-level policy ids resolve through their single line.
   */
  const linePolicyIds = [
    ...new Set(lines.map((l) => l.policyId).filter((id): id is string => !!id)),
  ];
  const anchorPolicyId =
    invoice.policyId ?? (linePolicyIds.length === 1 ? linePolicyIds[0] : null);
  const policy = policies.find((p) => p.id === anchorPolicyId) ?? null;
  const quote = !policy
    ? (quotes.find((q) => q.id === invoice.quoteId) ?? null)
    : null;
  /**
   * Rendered at the anchor statement rather than with the margin warnings
   * above. Those are about how the invoice is priced; this is about whether
   * it should exist.
   */
  const billWarning = directBillWarning(policy?.billType, lines);

  /**
   * One writer for the lines, so the summary table upstairs never disagrees
   * with the editor. Every mutation below goes through this rather than
   * `linesRes.setData`, which would update this component and nothing else.
   */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const linesRef = useRef(linesRes.data);
  linesRef.current = linesRes.data;
  function setLines(next: (ls: InvoiceLine[]) => InvoiceLine[]) {
    if (!alive.current) return;
    const updated = next(linesRef.current);
    linesRef.current = updated;
    linesRes.setData(updated);
    onLinesChange(invoice.id, updated);
  }

  // Keep drafts separate from returned rows. A save response must not erase
  // text entered while it was in flight, and failed writes remain retryable.
  const [invoiceDraft, setInvoiceDraft] = useState<Partial<Invoice>>({});
  const [lineDrafts, setLineDrafts] = useState<Record<string, Partial<InvoiceLine>>>({});
  const [moneyInputs, setMoneyInputs] = useState<Record<string, string>>({});
  const moneyInputsRef = useRef(moneyInputs);
  const acknowledgedInvoice = useRef(invoice);
  const acknowledgedChanges = useRef<Partial<Invoice>>({});
  const lastInvoiceProp = useRef(invoice);
  if (lastInvoiceProp.current !== invoice) {
    lastInvoiceProp.current = invoice;
    acknowledgedInvoice.current = invoice;
  }
  const invoiceDraftRef = useRef(invoiceDraft);
  const lineDraftsRef = useRef(lineDrafts);
  const queue = useRef(Promise.resolve());
  const actionPending = useRef(false);
  const [pending, setPending] = useState(0);
  const [actionBusy, setActionBusy] = useState(false);
  useEffect(() => { onBusyChange?.(pending > 0); }, [pending, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  const dirty = Object.keys(invoiceDraft).length > 0 || Object.keys(lineDrafts).length > 0;

  function editInvoice(patch: Partial<Invoice>) {
    invoiceDraftRef.current = { ...invoiceDraftRef.current, ...patch };
    setInvoiceDraft(invoiceDraftRef.current);
    saveStatus.markDirty();
  }
  function editLine(id: string, patch: Partial<InvoiceLine>) {
    lineDraftsRef.current = {
      ...lineDraftsRef.current, [id]: { ...lineDraftsRef.current[id], ...patch },
    };
    setLineDrafts(lineDraftsRef.current);
    saveStatus.markDirty();
  }
  function editMoney(id: string, field: "retailAmount" | "costAmount", raw: string) {
    moneyInputsRef.current = { ...moneyInputsRef.current, [`${id}:${field}`]: raw };
    setMoneyInputs(moneyInputsRef.current);
    editLine(id, { [field]: fromInput(raw) });
  }
  function remaining<T extends object>(current: T, submitted: T): T {
    const next = { ...current };
    for (const key of Object.keys(submitted) as (keyof T)[]) {
      if (Object.is(current[key], submitted[key])) delete next[key];
    }
    return next;
  }
  async function saveDrafts() {
    const invoicePatch = { ...invoiceDraftRef.current };
    const submittedMoney = { ...moneyInputsRef.current };
    for (const raw of Object.values(submittedMoney)) {
      if (raw.trim() && !Number.isFinite(Number(raw))) throw new Error("Enter a valid amount before saving or sending.");
    }
    const linePatches = Object.entries(lineDraftsRef.current);
    if (Object.keys(invoicePatch).length) {
      const { data, errors } = await client.models.Invoice.update({ id: invoice.id, ...invoicePatch });
      if (errors?.length || !data) throw new Error(errors?.[0]?.message ?? "Couldn't save invoice details.");
      if (!alive.current) return;
      acknowledgedInvoice.current = data;
      acknowledgedChanges.current = { ...acknowledgedChanges.current, ...invoicePatch };
      onChange(data);
      invoiceDraftRef.current = remaining(invoiceDraftRef.current, invoicePatch);
      setInvoiceDraft(invoiceDraftRef.current);
    }
    for (const [id, patch] of linePatches) {
      if (!alive.current) return;
      const { data, errors } = await client.models.InvoiceLine.update({ id, ...patch });
      if (errors?.length || !data) throw new Error(errors?.[0]?.message ?? "Couldn't save that line.");
      if (!alive.current) return;
      setLines(ls => ls.map(l => l.id === id ? data : l));
      const rest = remaining(lineDraftsRef.current[id] ?? {}, patch);
      const money = { ...moneyInputsRef.current };
      for (const field of ["retailAmount", "costAmount"] as const) {
        const key = `${id}:${field}`;
        if (money[key] === submittedMoney[key]) delete money[key];
        else if (Object.hasOwn(patch, field)) rest[field] = fromInput(money[key] ?? "");
      }
      moneyInputsRef.current = money;
      setMoneyInputs(money);
      const drafts = { ...lineDraftsRef.current };
      if (Object.keys(rest).length) drafts[id] = rest;
      else delete drafts[id];
      lineDraftsRef.current = drafts;
      setLineDrafts(drafts);
    }
  }
  // Blur saves are queued rather than dropped while another field is saving.
  // Send/void/add/remove run behind them and flush any still-focused draft.
  function enqueue(task: () => Promise<string | void>, savedMessage = "Saved.", sending = false, action = false) {
    if (action && actionPending.current) return Promise.resolve();
    if (action) { actionPending.current = true; setActionBusy(true); }
    onBusyChange?.(true);
    setPending(n => n + 1);
    const job = queue.current.then(async () => {
      if (!alive.current) return;
      await (sending ? sendStatus : saveStatus).run(async () => {
        await saveDrafts();
        if (alive.current) return task();
      }, { savedMessage, errorMessage: "Couldn't save that. Your changes are still here; try again." });
    }).finally(() => {
      if (action) actionPending.current = false;
      if (alive.current) {
        setPending(n => n - 1);
        if (action) setActionBusy(false);
      }
    });
    queue.current = job;
    return job;
  }
  function saveEdits() { return enqueue(async () => {}); }
  function patchInvoice(patch: Partial<Invoice>, savedMessage = "Saved.") {
    return enqueue(async () => {
      const { data, errors } = await client.models.Invoice.update({ id: invoice.id, ...patch });
      if (errors?.length || !data) throw new Error(errors?.[0]?.message ?? "Couldn't save invoice.");
      if (alive.current) {
        acknowledgedInvoice.current = data;
        acknowledgedChanges.current = { ...acknowledgedChanges.current, ...patch };
        onChange(data);
      }
    }, savedMessage, false, true);
  }

  /**
   * Add a line, optionally directly below an existing one.
   *
   * `after` is the row the + was pressed on. Everything below it is pushed down
   * a place first, so the new row lands where the button is rather than at the
   * bottom of the table — which is the whole point of putting the control on
   * the row. Each reorder is checked before creating the new row so failed
   * writes never silently change the order shown here.
   */
  function addLine(seed?: Partial<InvoiceLine>, after?: InvoiceLine) {
    return enqueue(async () => {
      const at = after ? (after.sortOrder ?? 0) + 1 : linesRef.current.length;
      if (after) {
        for (const line of linesRef.current.filter(l => (l.sortOrder ?? 0) >= at)
          .sort((a, b) => (b.sortOrder ?? 0) - (a.sortOrder ?? 0))) {
          const { data, errors } = await client.models.InvoiceLine.update({ id: line.id, sortOrder: (line.sortOrder ?? 0) + 1 });
          if (errors?.length || !data) throw new Error(errors?.[0]?.message ?? "Couldn't reorder the lines. Try adding again.");
          setLines(ls => ls.map(l => l.id === data.id ? data : l));
        }
      }
      const { data, errors } = await client.models.InvoiceLine.create({
        invoiceId: invoice.id, accountId: invoice.accountId,
        kind: "PREMIUM", description: "", sortOrder: at, ...seed,
      });
      if (errors?.length || !data) throw new Error(errors?.[0]?.message ?? "Couldn't add that line.");
      setLines(ls => [...ls, data]);
    }, "Line added.", false, true);
  }

  function removeLine(id: string) {
    return enqueue(async () => {
      const { errors } = await client.models.InvoiceLine.delete({ id });
      if (errors?.length) throw new Error(errors[0].message);
      setLines(ls => ls.filter(l => l.id !== id));
    }, "Line removed.", false, true);
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
  async function refreshAfterAction(fallback: Invoice, reflectsAction: (row: Invoice) => boolean) {
    try {
      const fresh = await client.models.Invoice.get({ id: invoice.id });
      const row = fresh.data;
      // A send can race a payment or void. Keep a returned protected state
      // even when the read has not caught up with the send or our saved edits.
      const statusOrder = ["DRAFT", "SENT", "PROCESSING", "PAID", "VOID"];
      if (!fresh.errors?.length && row && statusOrder.indexOf(row.status) > statusOrder.indexOf(fallback.status)) {
        fallback = { ...fallback, status: row.status, paidAt: row.paidAt, paymentUrl: row.paymentUrl };
      }
      const reflectsEdits = row && Object.entries(acknowledgedChanges.current)
        .every(([key, value]) => Object.is(row[key as keyof Invoice], value));
      if (!fresh.errors?.length && row && reflectsEdits && reflectsAction(row)) {
        if (alive.current) { acknowledgedInvoice.current = row; onChange(row); }
        return true;
      }
    } catch { /* The action succeeded; a failed read must not invite a resend. */ }
    if (alive.current) { acknowledgedInvoice.current = fallback; onChange(fallback); }
    return false;
  }

  async function voidThis() {
    await enqueue(
      async () => {
        const { data, errors } = await client.mutations.voidInvoice({
          invoiceId: invoice.id,
        });
        if (errors?.length) throw new Error(errors[0].message);
        // `a.json()` arrives as an AWSJSON string — see lib/aiExtraction.ts.
        const result =
          typeof data === "string" ? JSON.parse(data) : (data as Record<string, unknown>);
        if (!result?.ok) throw new Error(String(result?.error ?? "Void failed."));
        const refreshed = await refreshAfterAction(
          { ...acknowledgedInvoice.current, status: "VOID" },
          row => row.status === "VOID"
        );
        if (!refreshed) return "Invoice voided. Reopen it to refresh its details.";
      },
      "Voided.", false, true
    );
  }

  async function send() {
    await enqueue(
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
        const previousSentAt = acknowledgedInvoice.current.sentAt;
        const sentTo = typeof result.sentTo === "string" ? result.sentTo : toEmails.join(",");
        const recipients = (value: string | null | undefined) => (value ?? "").split(",").map(email => email.trim().toLowerCase()).sort().join(",");
        const refreshed = await refreshAfterAction(
          { ...acknowledgedInvoice.current, sentAt: new Date().toISOString(), sentTo },
          row => Boolean(row.sentAt && row.sentAt !== previousSentAt) && recipients(row.sentTo) === recipients(sentTo)
        );
        return `Sent to ${result.sentTo}.${!refreshed ? " Reopen the invoice to refresh its details." : ""}`;
      },
      "Sent.", true, true
    );
  }

  if (!linesRes.loaded) return <p className="muted small">Loading invoice…</p>;
  if (linesRes.error) return <p className="error-text">{linesRes.error} <button type="button" disabled={linesRes.loading} onClick={() => void linesRes.refetch()}>Retry invoice lines</button></p>;

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
          {dirty && <button type="button" disabled={pending > 0} onClick={() => void saveEdits()}>Save changes</button>}
          {/* Voided, not deleted: the number must never be reused, and a gap in
              the sequence is explainable in a way a reissue is not. */}
          {/* Not offered while a debit is clearing: an in-flight ACH cannot be
              un-collected, so the server refuses anyway — see void-invoice.
              The PROCESSING hint below the table says what to wait for. */}
          {!locked && invoice.status !== "PROCESSING" && (
            <ConfirmButton
              label="Void"
              busyLabel="Voiding…"
              className="danger"
              message="The number is retired, and the payment link is closed."
              disabled={actionBusy}
              onConfirm={() => voidThis()}
            />
          )}
          {locked && lines.length === 0 && (
            <ConfirmButton
              label="Delete"
              busyLabel="Deleting…"
              className="danger"
              message="It is void and has no lines."
              disabled={actionBusy}
              onConfirm={() => enqueue(async () => {
                const { errors } = await client.models.Invoice.delete({ id: invoice.id });
                if (errors?.length) throw new Error(errors[0].message);
                if (alive.current) onDeleted();
              }, "Deleted.", false, true)}
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
            {lines.map((savedLine) => {
              const l = { ...savedLine, ...lineDrafts[savedLine.id] };
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
                      value={l.description ?? ""}
                      disabled={locked || actionBusy}
                      onChange={e => editLine(l.id, { description: e.target.value })}
                      onBlur={() => void saveEdits()}
                    />
                  </td>
                  <td className="kind-col">
                    <select
                      aria-label="Kind"
                      value={l.kind ?? "PREMIUM"}
                      disabled={locked || actionBusy}
                      onChange={e => {
                        editLine(l.id, { kind: e.target.value as InvoiceLine["kind"] });
                        void saveEdits();
                      }}
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
                      type="text"
                      inputMode="decimal"
                      placeholder="0.00"
                      value={moneyInputs[`${l.id}:retailAmount`] ?? toInput(l.retailAmount)}
                      disabled={locked || actionBusy}
                      onChange={e => editMoney(l.id, "retailAmount", e.target.value)}
                      onBlur={() => void saveEdits()}
                    />
                  </td>
                  <td className="num internal band-start">
                    <input
                      aria-label="Costs the agency"
                      className="money"
                      type="text"
                      inputMode="decimal"
                      placeholder="0.00"
                      value={moneyInputs[`${l.id}:costAmount`] ?? toInput(l.costAmount)}
                      disabled={locked || actionBusy}
                      onChange={e => editMoney(l.id, "costAmount", e.target.value)}
                      onBlur={() => void saveEdits()}
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
                          disabled={actionBusy}
                          onClick={() => void addLine(undefined, l)}
                        >
                          +
                        </button>
                        <ConfirmButton
                          label="Remove"
                          busyLabel="Removing…"
                          className="danger"
                          disabled={actionBusy}
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
                  No lines yet. A new invoice opens with its anchor's premium
                  line; add one by hand with the button below.
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
          <button type="button" className="secondary" disabled={actionBusy} onClick={() => void addLine()}>
            {lines.length === 0 ? "Add line" : "Add line at the end"}
          </button>
          {policy && (
            <button
              type="button"
              className="secondary"
              disabled={actionBusy}
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
          <label>Bills</label>
          {/* W8: fixed at creation. Wrong anchor? Delete the draft and make
              a new one — re-pointing a bill is how two invoices land on one
              premium. */}
          <p style={{ margin: "4px 0 0" }}>
            {policy
              ? policyLabel(policy)
              : quote
                ? `Quote — ${(quote.lines ?? []).filter(Boolean).join(", ") || "coverage"}${quote.effectiveDate ? ` (${quote.effectiveDate})` : ""}`
                : "Nothing — this invoice predates anchored billing, and its lines bill more than one policy. Remove lines until one policy's remain (the invoice then bills that policy), or void this and bill each policy on its own invoice."}
          </p>
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
          ) : quote ? (
            <p className="muted small">
              Bills a quote — binding rolls this invoice (and any financing)
              onto the new policy.
            </p>
          ) : null}
        </div>
        <div className="field">
          <label htmlFor={inputId("issued")}>Issued</label>
          <input
            id={inputId("issued")}
            type="date"
            value={Object.hasOwn(invoiceDraft, "issuedAt") ? invoiceDraft.issuedAt ?? "" : invoice.issuedAt ?? ""}
            disabled={locked || actionBusy}
            onChange={e => editInvoice({ issuedAt: e.target.value || null })}
            onBlur={() => void saveEdits()}
          />
        </div>
        <div className="field">
          <label htmlFor={inputId("due")}>Due</label>
          <input
            id={inputId("due")}
            type="date"
            value={Object.hasOwn(invoiceDraft, "dueAt") ? invoiceDraft.dueAt ?? "" : invoice.dueAt ?? ""}
            disabled={locked || actionBusy}
            onChange={e => editInvoice({ dueAt: e.target.value || null })}
            onBlur={() => void saveEdits()}
          />
        </div>
        <div className="field full">
          <label htmlFor={inputId("memo")}>Memo</label>
          <textarea
            id={inputId("memo")}
            rows={2}
            placeholder="Optional. Shown to the association above the total."
            value={Object.hasOwn(invoiceDraft, "memo") ? invoiceDraft.memo ?? "" : invoice.memo ?? ""}
            disabled={locked || actionBusy}
            onChange={e => editInvoice({ memo: e.target.value || null })}
            onBlur={() => void saveEdits()}
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
                          disabled={actionBusy}
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
          {account && (policy || quote) && (
            <FinanceOfferHint
              account={account}
              anchor={
                policy
                  ? {
                      kind: "policy",
                      id: policy.id,
                      lines: policy.lines ?? [],
                    }
                  : {
                      kind: "quote",
                      id: quote!.id,
                      lines: quote!.lines ?? [],
                    }
              }
              retailTotal={totals.retail}
            />
          )}

          <div className="inline-actions">
            <button
              type="button"
              className="primary"
              disabled={actionBusy || lines.length === 0 || toEmails.length === 0}
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
            disabled={actionBusy}
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
