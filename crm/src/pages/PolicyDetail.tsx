import { Link, useParams } from "react-router-dom";
import {
  client,
  type Account,
  type Carrier,
  type Invoice,

} from "../lib/client";
import { listAllPages } from "../lib/pagination";
import { useAsyncResource } from "../lib/useAsyncResource";
import { SaveStatus, useSaveStatus } from "../components/SaveStatus";
import DocumentsPanel from "../components/DocumentsPanel";
import { InvoiceEditor } from "./policy/InvoiceEditor";
import { formatMoney } from "../lib/invoiceTotals";

/**
 * One policy, and what it has been billed.
 *
 * Policies were previously only ever a row inside an account's Policies tab.
 * Billing needs somewhere to stand — an invoice belongs to a policy, has lines
 * of its own and a send action — so this is that page. The tab now links here.
 */
export default function PolicyDetail() {
  const { id } = useParams<{ id: string }>();

  const res = useAsyncResource(
    async () => {
      if (!id) return null;
      const { data: policy } = await client.models.Policy.get({ id });
      if (!policy) return null;
      /**
       * Account and carrier in parallel with the invoices: none of them depend
       * on each other, and a policy page that loads in four serial round trips
       * feels broken on a slow connection even though nothing is wrong.
       */
      const [account, carrier, invoices] = await Promise.all([
        client.models.Account.get({ id: policy.accountId }),
        policy.carrierId
          ? client.models.Carrier.get({ id: policy.carrierId })
          : Promise.resolve({ data: null }),
        listAllPages((nextToken) =>
          client.models.Invoice.list({
            filter: { policyId: { eq: id } },
            nextToken,
          })
        ),
      ]);
      return {
        policy,
        account: account.data as Account | null,
        carrier: (carrier.data ?? null) as Carrier | null,
        invoices: invoices as Invoice[],
      };
    },
    [id],
    { initialData: null, errorMessage: "Failed to load policy" }
  );

  const createStatus = useSaveStatus();

  async function newInvoice() {
    const loaded = res.data;
    if (!loaded) return;
    await createStatus.run(
      async () => {
        /**
         * The number is reserved before the row exists, so two producers
         * clicking at once cannot collide. If the create then fails the number
         * is spent and the sequence has a gap — which is the trade this whole
         * scheme makes deliberately: gaps are explainable, reuse is not.
         */
        const reserved = await client.mutations.reserveInvoiceNumber();
        const raw = reserved.data;
        const parsed =
          typeof raw === "string" ? JSON.parse(raw) : (raw as Record<string, unknown>);
        const number =
          typeof parsed?.invoiceNumber === "string" ? parsed.invoiceNumber : null;

        const today = new Date().toISOString().slice(0, 10);
        const { data, errors } = await client.models.Invoice.create({
          accountId: loaded.policy.accountId,
          policyId: loaded.policy.id,
          number,
          status: "DRAFT",
          issuedAt: today,
        });
        if (errors?.length || !data) throw new Error(errors?.[0]?.message);
        res.setData((cur) =>
          cur ? { ...cur, invoices: [...cur.invoices, data] } : cur
        );
      },
      { savedMessage: "Invoice created.", errorMessage: "Couldn't create an invoice." }
    );
  }

  if (!res.loaded) return <p className="muted">Loading…</p>;
  if (res.error) return <p className="error-text">{res.error}</p>;
  if (!res.data) return <p>Policy not found.</p>;

  const { policy, account, carrier, invoices } = res.data;
  // Newest first: the one someone came here for is almost always the last made.
  const ordered = [...invoices].sort((a, b) =>
    (b.createdAt ?? "").localeCompare(a.createdAt ?? "")
  );

  return (
    <>
      <h1>{policy.policyNumber || "Policy"}</h1>
      <p className="sub">
        {account && <Link to={`/accounts/${account.id}`}>{account.name}</Link>}
        {carrier && <> · {carrier.name}</>}
        {policy.effectiveDate && policy.expirationDate && (
          <>
            {" "}
            · {policy.effectiveDate} to {policy.expirationDate}
          </>
        )}
      </p>

      <div className="card">
        <h2>Policy</h2>
        <dl className="pairs">
          <dt>Status</dt>
          <dd>{policy.status}</dd>
          <dt>Lines</dt>
          <dd>{(policy.lines ?? []).join(", ") || "—"}</dd>
          <dt>Premium</dt>
          <dd>{formatMoney(policy.premium)}</dd>
          <dt>Commission</dt>
          <dd>
            {typeof policy.commissionPct === "number"
              ? `${policy.commissionPct}%`
              : "—"}
          </dd>
        </dl>
        <p className="hint">
          Premium and commission are the policy's own record. An invoice below
          starts from them and is then edited on its own — what a carrier
          actually bills can differ from what the percentage implies.
        </p>
      </div>

      <div className="card">
        <div className="row-between">
          <h2>Invoices</h2>
          <div className="row-gap">
            <SaveStatus {...createStatus.status} />
            <button
              type="button"
              disabled={createStatus.busy}
              onClick={() => void newInvoice()}
            >
              New invoice
            </button>
          </div>
        </div>
        {ordered.length === 0 && (
          <p className="muted">Nothing billed on this policy yet.</p>
        )}
      </div>

      {ordered.map((inv) => (
        <InvoiceEditor
          key={inv.id}
          invoice={inv}
          policy={policy}
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

      <div className="card">
        <h2>Documents</h2>
        <DocumentsPanel entityType="ACCOUNT" entityId={policy.accountId} />
      </div>
    </>
  );
}
