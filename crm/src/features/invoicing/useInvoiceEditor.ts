import { useEffect, useRef, useState } from "react";
import { feeAllocations } from "../../../../shared/brokerFees";
import { billingContact, currentContacts } from "../../../../shared/contacts";
import { validateAdjustmentLines } from "../../../../shared/invoiceAdjustments";
import {
  directBillWarning,
  invoiceTotals,
  isPassThrough,
  marginWarnings,
  missingRemittanceCost,
  premiumLineFromPolicy
} from "../../../../shared/invoiceTotals";
import { listAllPages } from "../../../../shared/pagination";
import { useSaveStatus } from "../../components/SaveStatus";
import { assertGraphqlErrors } from '../../lib/apiResponse';
import { sendInvoice, voidInvoice } from '../../lib/billingApi';
import { confirmInvoicePayment } from '../../lib/brokerFees';
import {
  client,
  type Invoice,
  type InvoiceLine
} from "../../lib/client";
import { useLiveUpdateBlock } from "../../lib/useLiveUpdates";
import { fromInput } from './invoiceInputs';
import type { InvoiceEditorProps } from './types';
import { useInvoiceLines } from './useInvoiceLines';

export function useInvoiceEditor({
  invoice,
  policies,
  quotes,
  account,
  contacts,
  onChange,
  onLinesChange,
  onDeleted,
  onBusyChange,
}: InvoiceEditorProps) {
  const { linesRes, legacyPolicyCharges } = useInvoiceLines(invoice);

  const lines = [...linesRes.data].sort(
    (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
  );
  const lineChangeCallback = useRef(onLinesChange);
  lineChangeCallback.current = onLinesChange;
  useEffect(() => {
    if (linesRes.loaded && !linesRes.error) lineChangeCallback.current(invoice.id, linesRes.data);
  }, [invoice.id, linesRes.data, linesRes.loaded, linesRes.error]);

  const saveStatus = useSaveStatus({ autoClearMs: 4000 });
  const sendStatus = useSaveStatus();
  /**
   * Who it goes to, defaulting to the primary contact.
   *
   * Chosen from the account's contacts rather than typed. A free-text box
   * invites a typo into the one field where a mistake means the bill silently
   * never arrives — and every address worth using is already a Contact row.
   */
  const withEmail = currentContacts(contacts).filter((c) => (c.email ?? "").trim());
  const [toIds, setToIds] = useState<string[]>(() => {
    const primary = billingContact(withEmail);
    return primary ? [primary.id] : [];
  });
  const toEmails = toIds
    .map((id) => withEmail.find((c) => c.id === id)?.email?.trim())
    .filter((e): e is string => !!e);

  const totals = invoiceTotals(lines);
  const warnings = marginWarnings(lines);
  const locked = invoice.status === "VOID";
  const issuedFee = feeAllocations(invoice.brokerFeeAllocations).length > 0;
  const adjustment = invoice.sourcePricingVersion === 2;
  const sourcePricing = invoice.sourcePricingVersion === 1 || adjustment;
  const issuedPricing = sourcePricing && (invoice.status === "SENT" || !!invoice.stripePaymentLinkId);
  const linesLocked = locked || ["PAID", "PROCESSING"].includes(invoice.status) || issuedFee || issuedPricing;
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
  const needsRemittanceCost = missingRemittanceCost(lines.map(line => ({ ...line, ...lineDrafts[line.id] })));
  const needsSupplierAmount = !adjustment && sourcePricing && legacyPolicyCharges && lines.some(line => {
    const current = { ...line, ...lineDrafts[line.id] };
    if (current.sourceQuoteChargeId || !isPassThrough(current.kind)) return false;
    const amount = current.retailAmount;
    return typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount !== current.costAmount
      || Math.abs(amount * 100 - Math.round(amount * 100)) > .00001;
  });
  let adjustmentError = "";
  if (adjustment) {
    try { validateAdjustmentLines(lines.map(line => ({ ...line, ...lineDrafts[line.id] })), { billType: policy?.billType }); }
    catch (error) { adjustmentError = error instanceof Error ? error.message : "Review the adjustment amounts before sending."; }
  }
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
  // Preserve the observed send across a failed/lost response. Only a confirmed
  // action clears it; retrying must not turn a newly persisted sentAt into a resend.
  const sendAttempt = useRef<{ expectedSentAt: string; toEmail: string } | null>(null);
  const [pending, setPending] = useState(0);
  const [actionBusy, setActionBusy] = useState(false);
  useEffect(() => { onBusyChange?.(pending > 0); }, [pending, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  const dirty = Object.keys(invoiceDraft).length > 0 || Object.keys(lineDrafts).length > 0;
  useLiveUpdateBlock(dirty || pending > 0 || actionBusy || !!sendAttempt.current);

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
    const line = { ...linesRef.current.find(row => row.id === id), ...lineDraftsRef.current[id] };
    const mirrorCost = (adjustment || sourcePricing && legacyPolicyCharges) && !line.sourceQuoteChargeId && isPassThrough(line.kind);
    moneyInputsRef.current = { ...moneyInputsRef.current, [`${id}:${field}`]: raw, ...(mirrorCost ? { [`${id}:retailAmount`]: raw, [`${id}:costAmount`]: raw } : {}) };
    setMoneyInputs(moneyInputsRef.current);
    editLine(id, mirrorCost ? { retailAmount: fromInput(raw), costAmount: fromInput(raw) } : { [field]: fromInput(raw) });
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
      assertGraphqlErrors({ errors });
      if (!data) throw new Error(errors?.[0]?.message ?? "Couldn't save invoice details.");
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
      assertGraphqlErrors({ errors });
      if (!data) throw new Error(errors?.[0]?.message ?? "Couldn't save that line.");
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
  function saveEdits() { return enqueue(async () => { }); }

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
          assertGraphqlErrors({ errors });
          if (!data) throw new Error(errors?.[0]?.message ?? "Couldn't reorder the lines. Try adding again.");
          setLines(ls => ls.map(l => l.id === data.id ? data : l));
        }
      }
      const { data, errors } = await client.models.InvoiceLine.create({
        invoiceId: invoice.id, accountId: invoice.accountId,
        kind: "PREMIUM", description: "", sortOrder: at, ...seed,
      });
      assertGraphqlErrors({ errors });
      if (!data) throw new Error(errors?.[0]?.message ?? "Couldn't add that line.");
      setLines(ls => [...ls, data]);
    }, "Line added.", false, true);
  }

  function removeLine(id: string) {
    return enqueue(async () => {
      const { errors } = await client.models.InvoiceLine.delete({ id });
      assertGraphqlErrors({ errors: errors });
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
        await voidInvoice(invoice.id);
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
        if (missingRemittanceCost(linesRef.current)) throw new Error("Enter actual carrier/wholesaler remittance cost before sending.");
        if (adjustment) validateAdjustmentLines(linesRef.current, { billType: policy?.billType });
        const selected = toEmails.join(",");
        const recipientSet = (value: string) => value.split(",").map(email => email.trim().toLowerCase()).sort().join(",");
        if (sendAttempt.current && recipientSet(sendAttempt.current.toEmail) !== recipientSet(selected)) {
          throw new Error("The previous send used different recipients. Reopen the invoice and review its delivery before starting another send.");
        }
        sendAttempt.current ??= { expectedSentAt: acknowledgedInvoice.current.sentAt ?? "", toEmail: selected };
        const result = await sendInvoice({
          invoiceId: invoice.id,
          // Always explicit now that the recipients are chosen rather than
          // typed. The Lambda still falls back to the primary contact when
          // this is absent, which is what a resend from anywhere else does.
          toEmail: sendAttempt.current.toEmail,
          expectedSentAt: sendAttempt.current.expectedSentAt,
        });

        sendAttempt.current = null;
        // Generated fee lines can refresh from the quote at send; show the exact billed rows.
        if ((policy?.brokerFee ?? quote?.brokerFee ?? 0) > 0 || lines.some(line => line.kind === "BROKER_FEE")) {
          try {
            const billedLines = await listAllPages(nextToken => client.models.InvoiceLine.list({ filter: { invoiceId: { eq: invoice.id } }, nextToken }));
            if (alive.current) setLines(() => billedLines);
          } catch { /* Sending succeeded; reopening can refresh the displayed rows. */ }
        }
        const previousSentAt = acknowledgedInvoice.current.sentAt;
        const acceptedSentAt = typeof result.sentAt === "string" ? result.sentAt : undefined;
        const sentTo = typeof result.sentTo === "string" ? result.sentTo : toEmails.join(",");
        const recipients = (value: string | null | undefined) => (value ?? "").split(",").map(email => email.trim().toLowerCase()).sort().join(",");
        const refreshed = await refreshAfterAction(
          { ...acknowledgedInvoice.current, sentAt: acceptedSentAt ?? new Date().toISOString(), sentTo },
          row => Boolean(row.sentAt && (acceptedSentAt ? row.sentAt === acceptedSentAt : row.sentAt !== previousSentAt)) && recipients(row.sentTo) === recipients(sentTo)
        );
        return `Sent to ${result.sentTo}.${!refreshed ? " Reopen the invoice to refresh its details." : ""}`;
      },
      "Sent.", true, true
    );
  }

  function deleteThis() {
    return enqueue(async () => {
      const { errors } = await client.models.Invoice.delete({ id: invoice.id });
      assertGraphqlErrors({ errors: errors });
      if (alive.current) onDeleted();
    }, "Deleted.", false, true);
  }

  function markPaid() {
    return enqueue(async () => {
      await confirmInvoicePayment(invoice.id);
      const refreshed = await client.models.Invoice.get({ id: invoice.id });
      assertGraphqlErrors(refreshed);
      if (!refreshed.data) throw new Error("Payment recorded. Refresh the invoice to see its status.");
      if (alive.current) onChange(refreshed.data);
    }, "Marked paid.", false, true);
  }

  const inputId = (part: string) => `inv-${part}-${invoice.id}`;
  return {
    linesRes,
    invoice,
    saveStatus,
    dirty,
    pending,
    saveEdits,
    locked,
    actionBusy,
    voidThis,
    lines,
    sourcePricing,
    issuedFee,
    deleteThis,
    lineDrafts,
    adjustment,
    legacyPolicyCharges,
    linesLocked,
    editLine,
    moneyInputs,
    editMoney,
    addLine,
    removeLine,
    totals,
    issuedPricing,
    policy,
    addPremiumFromPolicy,
    warnings,
    quote,
    billWarning,
    inputId,
    invoiceDraft,
    editInvoice,
    withEmail,
    toIds,
    setToIds,
    account,
    toEmails,
    needsRemittanceCost,
    needsSupplierAmount,
    adjustmentError,
    send,
    sendStatus,
    markPaid,
  };
}

export type InvoiceEditorController = ReturnType<typeof useInvoiceEditor>;
