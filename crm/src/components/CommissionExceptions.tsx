import { CommissionTarget, useCommissionWorkflow } from '../lib/commissionWorkflow';
import { payrollRowKey } from '../../../shared/commissionPayroll';
import {
  useContext,
  useRef,
  useState,
  createContext,
  type ReactNode,
  type FormEvent,
} from "react";
import { commissionAction } from "../lib/commissions";
import { useAsyncResource } from "../lib/useAsyncResource";
import { useUnsavedChanges } from "../lib/editProtection";
import { isAuthorizationError } from "../lib/authorizationError";
import { decimal, type CommissionPolicy } from "../../../shared/commissions";
import { payrollDay } from "../../../shared/commissionPayroll";
import type {
  CommissionAdjustment,
  CommissionDeparture,
  CommissionEarning,
  departureWorklist,
} from "../../../shared/commissionExceptions";
import { ReportDownload } from "./ReportDownload";
import "./CommissionPayroll.css";
import CommissionPanel from "./CommissionPanel";

type Departure = CommissionDeparture & {
  worklist: ReturnType<typeof departureWorklist>;
};
export type CommissionExceptionWorkspace = {
  policies: CommissionPolicy[];
  earnings: CommissionEarning[];
  earningReviews?: {id:string;earningId:string;reason:string;at:string;by:string;amountCents:number}[];
  departures: Departure[];
  adjustments: CommissionAdjustment[];
  carrierAdjustments?: { policyId: string; policyNumber: string; accountName: string; unpaidAdjustment: number; paidRecovery: number; partialAdjustment?: number }[];
  producers: { id: string; name: string }[];
};
const money = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    n / 100,
  );
const Access = createContext<(error: unknown) => void>(() => {});
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return <CommissionPanel title={title}>{children}</CommissionPanel>;
}
function Field({
  label,
  value,
  set,
  type = "text",
  optional = false,
}: {
  label: string;
  value: string;
  set: (v: string) => void;
  type?: string;
  optional?: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type={type}
        value={value}
        required={!optional}
        onChange={(e) => set(e.target.value)}
      />
    </label>
  );
}
function Select({
  label,
  value,
  set,
  options,
}: {
  label: string;
  value: string;
  set: (v: string) => void;
  options: { id: string; name: string }[];
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} required onChange={(e) => set(e.target.value)}>
        <option value="">Choose…</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
}
function Form({
  label,
  action,
  refresh,
  children,
  disabled = false,
}: {
  label: string;
  action: () => Promise<unknown>;
  refresh: () => Promise<void>;
  children: ReactNode;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    lock = useRef(false),
    deny = useContext(Access);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save.");
      if (isAuthorizationError(e)) deny(e);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <form className="payroll-action" onSubmit={(e) => void submit(e)}>
      <fieldset disabled={busy}>
        <div className="payroll-form-body">{children}</div>
        <div className="payroll-form-footer commission-action-bar">
          <button className="primary" disabled={disabled}>
            {busy ? "Saving…" : label}
          </button>
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
    </form>
  );
}
function Confirm({
  value,
  set,
  children,
}: {
  value: boolean;
  set: (v: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="payroll-check">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => set(e.target.checked)}
      />
      {children}
    </label>
  );
}
export default function CommissionExceptions({
  refreshLedger,
  onAccessDenied,
}: {
  refreshLedger: () => Promise<void>;
  onAccessDenied: (error: unknown) => void;
}) {
  const { target, navigate } = useCommissionWorkflow();
  const resource = useAsyncResource(
    async () => {
      try {
        return await commissionAction<CommissionExceptionWorkspace>("commissionExceptions", {});
      } catch (e) {
        if (isAuthorizationError(e)) onAccessDenied(e);
        throw e;
      }
    },
    [],
    { clearDataOnError: () => true },
  );
  const refresh = async () => {
    await resource.refetch();
    await refreshLedger();
  };
  const data = resource.data;
  return (
    <Access.Provider
      value={(e) => {
        resource.invalidate(e);
        onAccessDenied(e);
      }}
    >
      <section className="payroll-workspace" aria-label="Commission exceptions">
        <div className="payroll-heading">
          <div>
            <h2>Shared commissions & employee changes</h2>
            <p className="muted">
              Approve policy shares, review departure earnings, and document
              compensation corrections.
            </p>
          </div>
          <button
            className="secondary"
            disabled={resource.loading}
            onClick={() => void resource.refetch()}
          >
            Refresh exceptions
          </button>
        </div>
        {resource.error && (
          <p role="alert" className="error-text">
            {resource.error}
          </p>
        )}
        {!data && !resource.error && <p>Loading commission cases…</p>}
        {data && (
          <>
            <div className="commission-action-bar"><button className="secondary" onClick={()=>navigate({tab:'queue'})}>Back to work queue</button>{(target.policyId||target.producerId||target.adjustmentId||target.departureId) && <button className="secondary" onClick={()=>navigate({tab:'exceptions'})}>Show all reviews</button>}</div>
            <Panel title="Approve a policy commission allocation">
              <AllocationForm data={data} refresh={refresh} />
            </Panel>
            <Panel title="Create a departure review">
              <DepartureForm data={data} refresh={refresh} />
            </Panel>
            <Panel title="Create a compensation adjustment">
              <AdjustmentForm data={data} refresh={refresh} />
            </Panel>
            {!!data.carrierAdjustments?.length && <section className="card">
              <h3>Carrier adjustments to review</h3>
              <p className="small muted">Reversals and restorations are proposed adjustments. They do not automatically reduce earnings or create payroll deductions. Review the source receipt in Ledger, then record any agreed compensation correction.</p>
              <div className="commission-scroll"><table><thead><tr><th>Account / policy</th><th>Unpaid earnings review</th><th>Partially paid review</th><th>Paid recovery review</th></tr></thead><tbody>
                {data.carrierAdjustments.map(r => <tr key={r.policyId}><td>{r.accountName}<div className="small muted">{r.policyNumber}</div></td><td>{money(r.unpaidAdjustment)}</td><td>{money(r.partialAdjustment??0)}</td><td>{money(r.paidRecovery)}</td></tr>)}
              </tbody></table></div>
            </section>}
            <h3>Approved policy allocations</h3>
            {!data.policies.some((p) => p.allocations?.length) && (
              <div className="payroll-empty">
                No shared allocations yet. Existing policies retain their
                original single-employee earnings.
              </div>
            )}
            {data.policies
              .filter((p) => p.allocations?.length)
              .map((p) => (
                <Panel
                  key={p.id}
                  title={p.accountName + " · " + p.policyNumber}
                >
                  {p.allocations!.map((a) => (
                    <div key={a.id}>
                      <p>
                        <strong>Receipts from {a.from}</strong> · {a.agreement}
                      </p>
                      <p className="small muted">
                        Approved {new Date(a.approvedAt).toLocaleString()} by{" "}
                        {a.approvedBy}
                      </p>
                      <div className="commission-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th>Employee</th>
                              <th>Policy share</th>
                              <th>Plan rate</th>
                              <th>Agreement</th>
                            </tr>
                          </thead>
                          <tbody>
                            {a.participants.map((p) => (
                              <tr key={p.producerId}>
                                <td>{p.producerName}</td>
                                <td>{p.shareBps / 100}%</td>
                                <td>{p.producerBps / 100}%</td>
                                <td>
                                  {p.agreement} · plan version {p.planVersion}
                                </td>
                              </tr>
                            ))}
                            {a.houseBps > 0 && (
                              <tr>
                                <td>Retained house share</td>
                                <td>{a.houseBps / 100}%</td>
                                <td colSpan={2}>No employee earnings</td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))}
                </Panel>
              ))}
            <h3>Departure reviews</h3>
            {!data.departures.length && (
              <div className="payroll-empty">
                No departure cases. Disabling CRM access never forfeits
                earnings.
              </div>
            )}
            {data.departures.filter(c=>!target.producerId||c.producerId===target.producerId).map((c) => (
              <CommissionTarget kind="departureId" id={c.id} key={c.id}>
              <DepartureCard
                key={c.id + ":" + c.version}
                value={c}
                data={data}
                refresh={refresh}
              /></CommissionTarget>
            ))}
            {!!data.earnings.filter((e) => ["REVIEW","RESOLVED"].includes(e.status)).length && (
              <>
                <h3>Carrier adjustments & recovery reviews</h3>
                {data.earnings
                  .filter((e) => ["REVIEW","RESOLVED"].includes(e.status) && (!target.policyId||e.policyId===target.policyId))
                  .map((e) => (
                    <CommissionTarget kind="earningId" id={e.id} key={e.id}><EarningReview
                      history={data.earningReviews?.filter(r=>r.earningId===e.id) ?? []}
                      key={e.id + ":" + e.version}
                      value={e}
                      refresh={refresh}
                    /></CommissionTarget>
                  ))}
              </>
            )}
            <h3>Compensation adjustments</h3>
            {!data.adjustments.length && (
              <div className="payroll-empty">
                No compensation adjustments recorded.
              </div>
            )}
            {data.adjustments.filter(a=>!target.policyId||a.policyId===target.policyId).map((a) => (
              <CommissionTarget kind="adjustmentId" id={a.id} key={a.id}>
              <AdjustmentCard
                key={a.id + ":" + a.version}
                value={a}
                data={data}
                refresh={refresh}
              /></CommissionTarget>
            ))}
          </>
        )}
      </section>
    </Access.Provider>
  );
}
function AllocationForm({
  data,
  refresh,
}: {
  data: CommissionExceptionWorkspace;
  refresh: () => Promise<void>;
}) {
  const {target}=useCommissionWorkflow();
  const [policyId, setPolicy] = useState(target.policyId ?? ""),
    [from, setFrom] = useState(""),
    [agreement, setAgreement] = useState(""),
    [house, setHouse] = useState("0"),
    [shares, setShares] = useState<Record<string, string>>({}),
    [confirmed, setConfirmed] = useState(false);
  useUnsavedChanges(!!policyId || !!agreement || !!Object.keys(shares).length);
  const policy = data.policies.find((p) => p.id === policyId);
  const update = (id: string, value: string) => {
    setConfirmed(false);
    setShares((s) => ({ ...s, [id]: value }));
  };
  return (
    <Form
      label="Approve policy allocation"
      disabled={!confirmed || !policy}
      refresh={refresh}
      action={async () => {
        await commissionAction("approvePolicyAllocation", {
          id: policyId,
          version: policy?.version,
          from,
          agreement,
          houseBps: decimal(house),
          participants: Object.entries(shares)
            .filter(([, v]) => v !== "" && decimal(v) !== 0)
            .map(([producerId, share]) => ({
              producerId,
              shareBps: decimal(share),
            })),
          confirmed,
        });
        setPolicy("");
        setAgreement("");
        setFrom("");
        setShares({});
        setConfirmed(false);
      }}
    >
      <p>
        Employee earnings = eligible agency commission × policy share × the
        employee’s frozen plan rate. Shares, including any retained house share,
        must total 100%. Changes apply to future receipts; historical
        corrections use an adjustment.
      </p>
      <div className="form-grid">
        <Select
          label="Allocation policy"
          value={policyId}
          set={(v) => {
            setPolicy(v);
            setConfirmed(false);
          }}
          options={data.policies.map((p) => ({
            id: p.id,
            name: p.accountName + " · " + p.policyNumber,
          }))}
        />
        <Field
          label="Apply to receipts from"
          type="date"
          value={from}
          set={(v) => {
            setFrom(v);
            setConfirmed(false);
          }}
        />
        <Field
          label="Retained house share (%)"
          value={house}
          set={(v) => {
            setHouse(v);
            setConfirmed(false);
          }}
        />
      </div>
      <div className="form-grid">
        {data.producers.map((p) => (
          <Field
            key={p.id}
            label={p.name + " policy share (%)"}
            optional
            value={shares[p.id] ?? ""}
            set={(v) => update(p.id, v)}
          />
        ))}
      </div>
      <Field
        label="Shared-production agreement reference"
        value={agreement}
        set={(v) => {
          setAgreement(v);
          setConfirmed(false);
        }}
      />
      <Confirm value={confirmed} set={setConfirmed}>
        I reviewed these policy shares and the employees’ assigned agreements.
        Apply their plan rates for this policy term.
      </Confirm>
    </Form>
  );
}
function DepartureForm({
  data,
  refresh,
  value,
}: {
  data: CommissionExceptionWorkspace;
  refresh: () => Promise<void>;
  value?: Departure;
}) {
  const {target}=useCommissionWorkflow();
  const blank = {
    producerId: target.producerId ?? "",
    employmentEndOn: "",
    eligibilityThrough: "",
    accessDisabledOn: "",
    agreement: "",
    evidence: "",
    reviewOn: payrollDay(),
    paymentDueOn: "",
    laterReceipts: "REVIEW",
    renewals: "REVIEW",
    ...(value
      ? {
          producerId: value.producerId,
          employmentEndOn: value.employmentEndOn,
          eligibilityThrough: value.eligibilityThrough ?? "",
          accessDisabledOn: value.accessDisabledOn ?? "",
          agreement: value.agreement,
          evidence: value.evidence,
          reviewOn: value.reviewOn,
          paymentDueOn: value.paymentDueOn,
          laterReceipts: value.laterReceipts,
          renewals: value.renewals,
        }
      : {}),
  };
  const [draft, setDraft] = useState(blank);
  useUnsavedChanges(JSON.stringify(draft) !== JSON.stringify(blank));
  const set = (key: keyof typeof blank) => (value: string) =>
    setDraft((d) => ({ ...d, [key]: value }));
  return (
    <Form
      label="Save departure for review"
      refresh={refresh}
      action={async () => {
        await commissionAction("saveCommissionDeparture", {
          ...draft,
          version: value?.version ?? 0,
        });
        setDraft(blank);
      }}
    >
      <p>
        Keep employment end, access removal, and earnings eligibility separate.
        This case records the agreement and payment dates; it does not disable a
        login or automatically forfeit commissions.
      </p>
      <div className="form-grid">
        <Select
          label="Departing employee"
          value={draft.producerId}
          set={set("producerId")}
          options={data.producers.filter((p) =>
            value
              ? p.id === value.producerId
              : !data.departures.some((c) => c.producerId === p.id),
          )}
        />
        <Field
          label="Employment end date"
          type="date"
          value={draft.employmentEndOn}
          set={set("employmentEndOn")}
        />
        <Field
          label="Eligibility review boundary (optional)"
          optional
          type="date"
          value={draft.eligibilityThrough}
          set={set("eligibilityThrough")}
        />
        <Field
          label="Access disabled date (optional)"
          optional
          type="date"
          value={draft.accessDisabledOn}
          set={set("accessDisabledOn")}
        />
        <Field
          label="Owner review due"
          type="date"
          value={draft.reviewOn}
          set={set("reviewOn")}
        />
        <Field
          label="HR payment due"
          type="date"
          value={draft.paymentDueOn}
          set={set("paymentDueOn")}
        />
      </div>
      <div className="form-grid">
        <Select
          label="Receipts after employment ends"
          value={draft.laterReceipts}
          set={set("laterReceipts")}
          options={[
            { id: "REVIEW", name: "Review each earning" },
            { id: "CONTINUE", name: "Continue the approved policy terms" },
          ]}
        />
        <Select
          label="Renewal receipts after employment ends"
          value={draft.renewals}
          set={set("renewals")}
          options={[
            { id: "REVIEW", name: "Review each earning" },
            { id: "CONTINUE", name: "Continue the approved policy terms" },
          ]}
        />
      </div>
      <Field
        label="Departure agreement reference"
        value={draft.agreement}
        set={set("agreement")}
      />
      <Field
        label="Departure supporting evidence"
        value={draft.evidence}
        set={set("evidence")}
      />
    </Form>
  );
}
function DepartureCard({
  value: c,
  data,
  refresh,
}: {
  value: Departure;
  data: CommissionExceptionWorkspace;
  refresh: () => Promise<void>;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const unresolved =
    c.worklist.rows.some(
      (r) =>
        r.decision === "REVIEW" ||
        (r.decision === "PAY" && r.paymentStatus !== "PAID"),
    ) ||
    c.worklist.pending.length > 0 ||
    c.worklist.adjustments.length > 0;
  return (
    <Panel
      title={
        c.producerName +
        " · " +
        (c.status === "CLOSED" && unresolved
          ? "Reopened worklist"
          : c.status.toLowerCase())
      }
    >
      <Panel title="Revise departure terms">
        <DepartureForm data={data} refresh={refresh} value={c} />
      </Panel>
      <dl className="commission-facts">
        <div><dt>Employment ended</dt><dd>{c.employmentEndOn}</dd></div>
        <div><dt>Owner review due</dt><dd>{c.reviewOn}</dd></div>
        <div><dt>HR payment due</dt><dd>{c.paymentDueOn}</dd></div>
      </dl>
      <details><summary>Agreement, evidence & decision history</summary><p>{c.agreement} · {c.evidence}</p>
        {c.decisions.map((d,i)=><p key={i}>{d.policyId} · {d.outcome} · {d.reason} · {d.at} · {d.by}</p>)}
        {c.pendingResolutions?.map((d,i)=><p key={'pending:'+i}>{d.policyId} · {d.reason} · {d.at} · {d.by}</p>)}
      </details>
      <p className="small muted">
        Later receipts: {c.laterReceipts.toLowerCase()} · Renewals:{" "}
        {c.renewals.toLowerCase()}. New receipts remain visible after access
        ends.
      </p>
      {c.status !== "DRAFT" && (
        <Form
          label="Download archived departure statement"
          refresh={async () => {}}
          action={async () => {
            const r = await commissionAction<{
              files: {
                filename: string;
                content: string;
                contentType: string;
              }[];
            }>("downloadDepartureStatement", { id: c.id });
            const f = r.files[0],
              url = URL.createObjectURL(
                new Blob(
                  [Uint8Array.from(atob(f.content), (c) => c.charCodeAt(0))],
                  { type: f.contentType },
                ),
              );
            const a = document.createElement("a");
            a.href = url;
            a.download = f.filename;
            document.body.append(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          <p className="small muted">
            Save a versioned review statement with the current earnings,
            decisions, and payment status. This does not authorize another
            payment.
          </p>
        </Form>
      )}
      <ReportDownload
        report={{
          title: c.producerName + " departure commission worklist",
          filters: "Owner review · " + c.status + " · " + c.agreement,
          sections: [
            {
              title: "Employee earnings",
              columns: [
                "Policy",
                "Receipt date",
                "Amount (USD)",
                "Decision",
                "Payment status",
              ],
              rows: c.worklist.rows.map((r) => [
                r.policyNumber,
                r.receivedOn,
                r.amountCents / 100,
                r.decision,
                r.paymentStatus,
              ]),
            },
            {
              title: "Awaiting carrier reconciliation",
              columns: [
                "Policy",
                "Expected agency (USD)",
                "Received agency (USD)",
              ],
              rows: c.worklist.pending.map((r) => [
                r.policyNumber,
                r.expectedAgencyCents / 100,
                r.receivedAgencyCents / 100,
              ]),
            },
          ],
        }}
      />
      {c.status === "DRAFT" ? (
        <Form
          label={"Approve departure terms for " + c.producerName}
          disabled={!confirmed}
          refresh={refresh}
          action={() =>
            commissionAction("approveCommissionDeparture", {
              id: c.id,
              version: c.version,
              confirmed,
            })
          }
        >
          <Confirm value={confirmed} set={setConfirmed}>
            I reviewed the agreement, receipt treatment, and HR payment dates.
          </Confirm>
        </Form>
      ) : (
        <>
          <div className="commission-scroll">
            <table>
              <thead>
                <tr>
                  <th>Policy / receipt</th>
                  <th>Employee amount</th>
                  <th>Eligibility</th>
                  <th>Payment</th>
                </tr>
              </thead>
              <tbody>
                {c.worklist.rows.map((r) => (
                  <tr key={r.earningId ?? r.policyId + ":" + r.entryId}>
                    <td>
                      {r.policyNumber}
                      <div className="small muted">{r.receivedOn}</div>
                    </td>
                    <td>{money(r.amountCents)}</td>
                    <td><span className={"badge " + (r.decision === "REVIEW" ? "amber" : r.decision === "PAY" ? "blue" : "gray")}>{r.decision}</span></td>
                    <td>
                      <span className={"badge " + (r.paymentStatus === "PAID" ? "green" : "gray")}>{r.paymentStatus}</span>
                      {r.batchPaidCents !== undefined && (
                        <div className="small muted">
                          Employee batch paid {money(r.batchPaidCents)} of{" "}
                          {money(r.batchTotalCents!)}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {c.worklist.rows
            .filter(
              (r) =>
                !r.batchId &&
                !c.decisions.some(
                  (d) =>
                    d.policyId === r.policyId &&
                    d.entryId === r.entryId &&
                    d.earningId === r.earningId,
                ),
            )
            .map((r) => (
              <DepartureDecision
                key={r.earningId ?? r.policyId + ":" + r.entryId}
                value={c}
                row={r}
                refresh={refresh}
              />
            ))}
          {!!c.worklist.pending.length && (
            <div className="payroll-notice">
              <strong>Awaiting carrier receipts or reconciliation</strong>
              <ul>
                {c.worklist.pending.map((p) => (
                  <li key={p.policyId}>
                    {p.policyNumber}: expected agency{" "}
                    {money(p.expectedAgencyCents)}, received{" "}
                    {money(p.receivedAgencyCents)}. These are agency estimates,
                    not payable employee earnings.
                  </li>
                ))}
              </ul>
            </div>
          )}
          {c.worklist.pending.map((p) => (
            <PendingResolution
              key={p.policyId}
              value={c}
              policyId={p.policyId}
              policyNumber={p.policyNumber}
              refresh={refresh}
            />
          ))}
          {!!c.worklist.adjustments.length && (
            <p role="alert">
              Review {c.worklist.adjustments.length} proposed adjustments
              separately. Recoveries do not reduce payroll automatically.
            </p>
          )}
          {c.status !== "CLOSED" && !unresolved && (
            <Form
              label="Close completed departure review"
              refresh={refresh}
              disabled={!confirmed}
              action={() =>
                commissionAction("closeCommissionDeparture", {
                  id: c.id,
                  version: c.version,
                  confirmed,
                })
              }
            >
              <Confirm value={confirmed} set={setConfirmed}>
                All carrier receipts, eligibility decisions, and payments are
                resolved.
              </Confirm>
            </Form>
          )}
        </>
      )}
    </Panel>
  );
}
function DepartureDecision({
  value: c,
  row: r,
  refresh,
}: {
  value: Departure;
  row: Departure["worklist"]["rows"][number];
  refresh: () => Promise<void>;
}) {
  const [outcome, setOutcome] = useState(""),
    [reason, setReason] = useState(""),
    [confirmed, setConfirmed] = useState(false);
  useUnsavedChanges(!!outcome || !!reason);
  return (
    <Panel
      title={
        "Review " +
        r.policyNumber +
        " · " +
        r.receivedOn +
        " · " +
        money(r.amountCents)
      }
    >
      <Form
        label="Approve eligibility decision"
        disabled={!confirmed}
        refresh={refresh}
        action={() =>
          commissionAction("decideDepartureEarning", {
            id: c.id,
            version: c.version,
            policyId: r.policyId,
            entryId: r.entryId,
            earningId: r.earningId,
            outcome,
            reason,
            confirmed,
          })
        }
      >
        <Select
          label="Departure earnings decision"
          value={outcome}
          set={setOutcome}
          options={[
            { id: "PAY", name: "Pay under the approved agreement" },
            { id: "EXCLUDE", name: "Exclude with agreement evidence" },
          ]}
        />
        <Field
          label="Eligibility decision evidence"
          value={reason}
          set={setReason}
        />
        <Confirm value={confirmed} set={setConfirmed}>
          I reviewed the agreement and this specific earning.
        </Confirm>
      </Form>
    </Panel>
  );
}
function AdjustmentForm({
  data,
  refresh,
  value,
}: {
  data: CommissionExceptionWorkspace;
  refresh: () => Promise<void>;
  value?: CommissionAdjustment;
}) {
  const {target}=useCommissionWorkflow();
  const blank = {
    policyId: target.policyId ?? "",
    producerId: target.producerId ?? "",
    kind: "ADDITIONAL",
    target: "",
    corrected: "",
    effectiveOn: payrollDay(),
    reason: "",
    evidence: "",
    ...(value
      ? {
          policyId: value.policyId,
          producerId: value.producerId,
          kind: value.adjustmentType,
          target: value.targetEarningId
            ? "earning:" + value.targetEarningId
            : value.targetEntryId
              ? "entry:" + value.targetEntryId
              : "",
          corrected: (value.correctedCents / 100).toFixed(2),
          effectiveOn: value.effectiveOn,
          reason: value.reason,
          evidence: value.evidence,
        }
      : {}),
  };
  const [draft, setDraft] = useState(blank),
    [id, setId] = useState(() => value?.id ?? crypto.randomUUID());
  useUnsavedChanges(JSON.stringify(draft) !== JSON.stringify(blank));
  const set = (key: keyof typeof blank) => (value: string) =>
    setDraft((d) => ({
      ...d,
      [key]: value,
      ...(["policyId", "producerId", "kind"].includes(key)
        ? { target: "" }
        : {}),
    }));
  const policy = data.policies.find((p) => p.id === draft.policyId);
  const targets = [
    ...(policy?.producerId === draft.producerId
      ? policy.entries
          .filter(
            (e) => !e.allocationId && !e.supersededBy && e.kind === "RECEIPT",
          )
          .map((e) => ({
            id: "entry:" + e.id,
            name:
              e.receivedOn + " · " + e.lineRef + " · " + money(e.producerCents),
          }))
      : []),
    ...data.earnings
      .filter(
        (e) =>
          e.policyId === draft.policyId &&
          e.producerId === draft.producerId &&
          e.status !== "SUPERSEDED" &&
          e.amountCents > 0,
      )
      .map((e) => ({
        id: "earning:" + e.id,
        name:
          e.receivedOn +
          " · " +
          e.source.toLowerCase() +
          " · " +
          money(e.amountCents),
      })),
  ];
  return (
    <Form
      label="Save adjustment for review"
      refresh={refresh}
      action={async () => {
        await commissionAction("saveCommissionAdjustment", {
          ...draft,
          id,
          version: value?.version ?? 0,
          correctedCents: decimal(draft.corrected),
          ...(draft.target.startsWith("earning:")
            ? { targetEarningId: draft.target.slice(8) }
            : draft.target.startsWith("entry:")
              ? { targetEntryId: draft.target.slice(6) }
              : {}),
        });
        setDraft(blank);
        setId(crypto.randomUUID());
      }}
    >
      <p>
        Additional earnings and unpaid corrections require Owner approval before
        payroll. A paid recovery is a review record only and never reduces an
        employee’s payroll automatically.
      </p>
      <div className="form-grid">
        <Select
          label="Adjustment policy"
          value={draft.policyId}
          set={set("policyId")}
          options={data.policies.map((p) => ({
            id: p.id,
            name: p.accountName + " · " + p.policyNumber,
          }))}
        />
        <Select
          label="Adjustment employee"
          value={draft.producerId}
          set={set("producerId")}
          options={data.producers}
        />
        <Select
          label="Adjustment type"
          value={draft.kind}
          set={set("kind")}
          options={[
            { id: "ADDITIONAL", name: "Additional earnings" },
            { id: "UNPAID_CORRECTION", name: "Correct unpaid earnings" },
            { id: "PAID_RECOVERY", name: "Proposed recovery after payment" },
          ]}
        />
        {draft.kind !== "ADDITIONAL" && (
          <Select
            label="Original employee earning"
            value={draft.target}
            set={set("target")}
            options={targets}
          />
        )}
        <Field
          label={
            draft.kind === "ADDITIONAL"
              ? "Additional earnings (USD)"
              : "Corrected total earnings (USD)"
          }
          value={draft.corrected}
          set={set("corrected")}
        />
        <Field
          label="Adjustment effective date"
          type="date"
          value={draft.effectiveOn}
          set={set("effectiveOn")}
        />
      </div>
      <Field
        label="Compensation adjustment reason"
        value={draft.reason}
        set={set("reason")}
      />
      <Field
        label="Compensation adjustment evidence"
        value={draft.evidence}
        set={set("evidence")}
      />
    </Form>
  );
}
function AdjustmentCard({
  value: a,
  data,
  refresh,
}: {
  value: CommissionAdjustment;
  data: CommissionExceptionWorkspace;
  refresh: () => Promise<void>;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const {navigate}=useCommissionWorkflow();
  const earning=data.earnings.find(e=>e.adjustmentId===a.id&&e.status==="PAYABLE"&&!e.batchId);
  return (
    <Panel
      title={
        (data.producers.find((p) => p.id === a.producerId)?.name ??
          a.producerId) +
        " · " +
        a.adjustmentType.replaceAll("_", " ").toLowerCase() +
        " · " +
        a.status.toLowerCase()
      }
    >
      <p>
        {data.policies.find((p) => p.id === a.policyId)?.policyNumber} ·
        Effective {a.effectiveOn}
      </p>
      <div className="payroll-balances">
        <span>
          Original <strong>{money(a.originalCents)}</strong>
        </span>
        <span>
          Corrected <strong>{money(a.correctedCents)}</strong>
        </span>
        <span>
          Change <strong>{money(a.amountCents)}</strong>
        </span>
      </div>
      <p>{a.reason}</p>
      <details><summary>Source evidence & decision history</summary><p>{a.evidence}</p><p>Source entry: {a.targetEntryId ?? a.targetEarningId ?? 'Additional earnings'} · {a.status.toLowerCase()}</p>{a.approvedAt&&<p>Approved {a.approvedAt} by {a.approvedBy}</p>}</details>
      <div className="commission-action-bar"><button className="secondary" onClick={()=>navigate({tab:'ledger',policyId:a.policyId})}>Review original policy earnings</button>
      {earning && <button className="secondary" onClick={()=>navigate({tab:'payroll',earningKeys:[payrollRowKey(earning)],producerId:earning.producerId})}>Prepare off-cycle payment</button>}</div>
      {a.adjustmentType === "PAID_RECOVERY" && (
        <p className="payroll-notice">
          Proposed recovery only. No automatic payroll deduction.
        </p>
      )}
      {a.status === "DRAFT" && (
        <Panel title="Edit draft adjustment">
          <AdjustmentForm data={data} refresh={refresh} value={a} />
        </Panel>
      )}
      {a.status === "DRAFT" && <CancelAdjustment value={a} refresh={refresh} />}
      {a.status === "DRAFT" ? (
        <Form
          label="Approve compensation adjustment"
          disabled={!confirmed}
          refresh={refresh}
          action={() =>
            commissionAction("approveCommissionAdjustment", {
              id: a.id,
              version: a.version,
              confirmed,
            })
          }
        >
          <Confirm value={confirmed} set={setConfirmed}>
            I reviewed the source earnings, agreement evidence, and corrected
            amount.
          </Confirm>
        </Form>
      ) : a.status === "APPROVED" ? (
        <p className="small muted">
          Approved {new Date(a.approvedAt!).toLocaleString()} by {a.approvedBy}.
          Original records remain in the audit history.
        </p>
      ) : (
        <p className="small muted">Cancelled: {a.cancellationReason}</p>
      )}
    </Panel>
  );
}

function PendingResolution({
  value: c,
  policyId,
  policyNumber,
  refresh,
}: {
  value: Departure;
  policyId: string;
  policyNumber: string;
  refresh: () => Promise<void>;
}) {
  const [reason, setReason] = useState(""),
    [confirmed, setConfirmed] = useState(false);
  useUnsavedChanges(!!reason);
  return (
    <Panel title={"Resolve pending carrier balance · " + policyNumber}>
      <Form
        label="Record carrier balance resolution"
        disabled={!confirmed}
        refresh={refresh}
        action={() =>
          commissionAction("settleDeparturePolicy", {
            id: c.id,
            version: c.version,
            policyId,
            reason,
            confirmed,
          })
        }
      >
        <p>
          This records a reviewed estimate or final carrier settlement without
          changing carrier cash. A later receipt reopens this balance for
          review.
        </p>
        <Field
          label="Final carrier settlement evidence"
          value={reason}
          set={setReason}
        />
        <Confirm value={confirmed} set={setConfirmed}>
          I verified that no further carrier receipts are expected for this
          policy.
        </Confirm>
      </Form>
    </Panel>
  );
}

function EarningReview({
  value: e,
  refresh,
  history,
}: {
  value: CommissionEarning;
  refresh: () => Promise<void>;
  history: NonNullable<CommissionExceptionWorkspace["earningReviews"]>;
}) {
  const {navigate}=useCommissionWorkflow();
  const [reason, setReason] = useState(""),
    [confirmed, setConfirmed] = useState(false);
  useUnsavedChanges(!!reason);
  return (
    <Panel
      title={
        e.producerName + " · " + e.policyNumber + " · " + money(e.amountCents)
      }
    >
      <p>{e.receivedOn} · {e.source.toLowerCase()} · {e.status.toLowerCase()} · affected employee amount {money(e.amountCents)}</p>
      <button className="secondary" onClick={()=>navigate({tab:'ledger',policyId:e.policyId})}>Review source receipt</button>
      <details><summary>Resolution history</summary>{history.length?history.map(r=><p key={r.id}>{r.reason} · {r.at} · {r.by} · {money(r.amountCents)}</p>):<p>No resolution recorded.</p>}</details>
      {e.status==='REVIEW' && <Form
        label="Record review resolution"
        disabled={!confirmed}
        refresh={refresh}
        action={() =>
          commissionAction("resolveCommissionEarningReview", {
            id: e.id,
            version: e.version,
            reason,
            confirmed,
          })
        }
      >
        <p>
          Close this review only after documenting its treatment. This action
          does not collect a recovery, deduct wages, or create payable earnings.
          Use a separately approved compensation adjustment if an additional
          payment is required.
        </p>
        <Field
          label="Earnings review resolution evidence"
          value={reason}
          set={setReason}
        />
        <Confirm value={confirmed} set={setConfirmed}>
          I verified the resolution and any separate payment or recovery
          handling.
        </Confirm>
      </Form>}
    </Panel>
  );
}

function CancelAdjustment({
  value: a,
  refresh,
}: {
  value: CommissionAdjustment;
  refresh: () => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  useUnsavedChanges(!!reason);
  return (
    <Panel title="Cancel draft adjustment">
      <Form
        label="Cancel adjustment draft"
        refresh={refresh}
        action={() =>
          commissionAction("cancelCommissionAdjustment", {
            id: a.id,
            version: a.version,
            reason,
          })
        }
      >
        <Field
          label="Adjustment cancellation reason"
          value={reason}
          set={setReason}
        />
      </Form>
    </Panel>
  );
}
