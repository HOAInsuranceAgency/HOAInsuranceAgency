import {
  client,
  listAllPages,
  type Invoice,
  type Policy,
} from "../../lib/client";
import { useAsyncResource } from "../../lib/useAsyncResource";
import { SaveStatus, useSaveStatus } from "../../components/SaveStatus";
import { InvoiceEditor } from "../../components/InvoiceEditor";

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
 * So the account owns the list, and the policy is a *field on an invoice*
 * instead of the route to it. That is also what the send email already assumed —
 * it addresses the account's primary contact, not a policy's.
 */
export function InvoicesTab({ accountId }: { accountId: string }) {
  const res = useAsyncResource(
    async () => {
      /**
       * Invoices and policies together: the editor needs the policy list to
       * offer "which policy does this bill", and fetching it per-invoice would
       * be one round trip per row for the same handful of rows.
       */
      const [invoices, policies] = await Promise.all([
        listAllPages((nextToken) =>
          client.models.Invoice.list({
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
      ]);
      return { invoices: invoices as Invoice[], policies: policies as Policy[] };
    },
    [accountId],
    { initialData: null, errorMessage: "Failed to load invoices" }
  );

  const createStatus = useSaveStatus();

  async function newInvoice() {
    if (!res.data) return;
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

        const { data, errors } = await client.models.Invoice.create({
          accountId,
          number,
          status: "DRAFT",
          issuedAt: new Date().toISOString().slice(0, 10),
        });
        if (errors?.length || !data) throw new Error(errors?.[0]?.message);
        res.setData((cur) =>
          cur ? { ...cur, invoices: [data, ...cur.invoices] } : cur
        );
      },
      { savedMessage: "Invoice created.", errorMessage: "Couldn't create an invoice." }
    );
  }

  if (!res.loaded) return <p className="muted small">Loading…</p>;
  if (res.error) return <p className="error-text">{res.error}</p>;
  if (!res.data) return null;

  const { invoices, policies } = res.data;
  // Newest first: the one someone came here for is almost always the last made.
  const ordered = [...invoices].sort((a, b) =>
    (b.createdAt ?? "").localeCompare(a.createdAt ?? "")
  );

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2>Invoices</h2>
          <div className="inline-actions">
            <SaveStatus {...createStatus.status} />
            <button
              type="button"
              className="primary"
              disabled={createStatus.busy}
              onClick={() => void newInvoice()}
            >
              New invoice
            </button>
          </div>
        </div>
        {ordered.length === 0 && (
          <p className="muted small">
            Nothing billed yet. A new invoice starts as a draft — it is not
            numbered on the association's side until you send it.
          </p>
        )}
      </div>

      {ordered.map((inv) => (
        <InvoiceEditor
          key={inv.id}
          invoice={inv}
          policies={policies}
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
          onDeleted={() =>
            res.setData((cur) =>
              cur
                ? { ...cur, invoices: cur.invoices.filter((i) => i.id !== inv.id) }
                : cur
            )
          }
        />
      ))}
    </>
  );
}

export default InvoicesTab;
