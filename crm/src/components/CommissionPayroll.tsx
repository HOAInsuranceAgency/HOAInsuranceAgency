import { payrollRevenueKind, payrollSourceLabel } from "../../../shared/commissionPayroll";
import { formatUsdCents as money } from "../../../shared/money";
import { zipSync } from "fflate";
import {
createContext,
useContext,
useEffect,
useRef,
useState,
type FormEvent,
type ReactNode,
} from "react";
import {
COMMISSION_START_MONTH,
payrollApprovalIssues,
payrollCutoffIssue,
payrollDay,
payrollRowKey,
suggestPayrollDates,
type PayrollCycle,
type PayrollSettings,
type PayrollWorkspace,
} from "../../../shared/commissionPayroll";
import {
batchPaidCents,
decimal,
sum,
type CommissionBatch,
} from "../../../shared/commissions";
import { isAuthorizationError } from "../../../shared/authorizationError";
import { useEditProtection,useCommissionUnsavedChanges as useUnsavedChanges } from "../lib/commissionEditProtection";
import { sourcePayrollHandoff } from "../lib/commissionPayrollHandoff";
import { commissionWorkflowAction as commissionAction } from "../lib/commissions";
import { useCommissionPreference,useCommissionWorkflow } from '../lib/commissionWorkflow';
import { useAsyncResource } from "../lib/useAsyncResource";
import CommissionJourney from "./CommissionJourney";
import CommissionPanel from "./CommissionPanel";
import "./CommissionPayroll.css";
import Modal from './Modal';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Select } from './ui/Select';
import { Table } from './ui/Table';


const displayDate = (value: string) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value + "T12:00:00Z"));
const displayMonth = (value: string) =>
  new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value.slice(0, 7) + "-01T12:00:00Z"));
function approvalOpensOn(cutoff: string) {
  const date = new Date(cutoff + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + 1);
  return displayDate(date.toISOString().slice(0, 10));
}
function PayrollScheduleNotice({ cutoff }: { cutoff: string }) {
  if (!payrollCutoffIssue({ cutoff })) return null;
  return <div className="payroll-notice" role="status" aria-label="Payroll schedule">
    <strong>Approval opens {approvalOpensOn(cutoff)}</strong>
    <p>The inclusive receipt cutoff ends on {displayDate(cutoff)} (Eastern time). You can save a draft now; approval waits until the next day.</p>
    <p>This is a scheduled wait. For an earlier payroll, review the cutoff and remaining dates before saving.</p>
  </div>;
}
function openPayrollDates(id: string) {
  const panel = document.getElementById("payroll-edit-" + id) as HTMLDetailsElement | null;
  if (!panel) return;
  panel.open = true;
  panel.scrollIntoView?.({ block: "start" });
  (panel.querySelector('input[type="date"]') as HTMLInputElement | null)?.focus({ preventScroll: true });
}
function StatusBadge({ status }: { status: string }) {
  const tone = ["PAID", "SENT"].includes(status)
    ? "green"
    : status === "APPROVED"
      ? "blue"
      : ["FAILED", "UNKNOWN"].includes(status)
        ? "red"
        : ["OPEN", "SENDING"].includes(status)
          ? "amber"
          : "gray";
  const label =
    (
      {
        OPEN: "Awaiting approval",
        APPROVED: "Approved",
        PAID: "Paid",
        CANCELLED: "Cancelled",
        SENT: "Accepted by email service",
        SENDING: "Sending",
        FAILED: "Failed",
        UNKNOWN: "Needs review",
      } as Record<string, string>
    )[status] ?? status;
  return <span className={"badge " + tone}>{label}</span>;
}
function Panel({
  title,
  hint,
  children,
  danger = false,
  open,
  id,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  danger?: boolean;
  open?: boolean;
  id?: string;
}) {
  return <CommissionPanel id={id} title={title} hint={hint} danger={danger} open={open}>{children}</CommissionPanel>;
}
const PayrollAccessContext = createContext<(error: unknown) => void>(() => {});
export default function CommissionPayroll({
  owner,
  refreshLedger,
  onAccessDenied,
  reviewStatements,
}: {
  owner: boolean;
  refreshLedger: () => Promise<void>;
  onAccessDenied?: (error: unknown) => void;
  reviewStatements?: () => void;
}) {
  const [auditOpen, setAuditOpen] = useState(false), [historyQuery,setHistoryQuery]=useState('');
  const { target, navigate, remember } = useCommissionWorkflow();
  const [selectedCycle, saveSelectedCycle] = useCommissionPreference('payroll-cycle','');
  const setSelectedCycle=(id:string)=>{saveSelectedCycle(id);remember?.({cycleId:id,intakeId:undefined,intakeReference:undefined,intakeStep:undefined});};
  const { requestLeave } = useEditProtection();
  const resource = useAsyncResource(
    async () => {
      try {
        const workspace = await commissionAction<PayrollWorkspace>(
          "payrollWorkspace",
          {},
        );
        return { workspace };
      } catch (error) {
        if (isAuthorizationError(error)) onAccessDenied?.(error);
        throw error;
      }
    },
    [owner],
    { clearDataOnError: () => true, live: { topics: ['OWNER'], protectEdits: true } },
  );
  const refresh = async () => {
    await resource.refetch();
    await refreshLedger();
  };
  const data = resource.data;
  const cycles = data?.workspace.cycles ?? [];
  useEffect(()=>{
    if (target.cycleId) saveSelectedCycle(target.cycleId);
  },[target.cycleId,target.intakeId,data]);
  const source = data && target.intakeId ? sourcePayrollHandoff(data.workspace, target.intakeId) : undefined;
  const handoff = !!source && (!target.cycleId || !cycles.some(c => c.id === target.cycleId));
  const focused = target.cycleId ? cycles.find(c => c.id === target.cycleId) : cycles.find(c => c.id === selectedCycle) ??
    cycles.filter(c => c.status === "OPEN").sort((a,b) => a.cutoff.localeCompare(b.cutoff))[0] ??
    cycles.find(c => c.status === "APPROVED") ?? cycles[0];
  const journeyStep = handoff ? 4 : focused?.status === "PAID" ? 6 : focused?.status === "APPROVED" ? 5 : 4;
  const [inspectedStep, inspectStep] = useState<number | null>(null);
  useEffect(() => inspectStep(null), [journeyStep, focused?.id]);
  const chooseJourneyStep = (step: number) => {
    if (step < 4) { navigate({tab:"statements",intakeId:target.intakeId,intakeReference:target.intakeReference,intakeStep:step,cycleId:target.cycleId}); return; }
    inspectStep(step);
    const root = document.getElementById((step === 4 ? "payroll-cycle-" : "payroll-payments-") + focused?.id);
    if (root?.tagName === "DETAILS") (root as HTMLDetailsElement).open = true;
    root?.scrollIntoView?.({block:"start"});
  };
  const selectedDeliveries = data?.workspace.deliveries.filter(d=>!focused||d.cycleId===focused.id) ?? [];
  return (
    <PayrollAccessContext.Provider
      value={(error) => {
        resource.invalidate(error);
        onAccessDenied?.(error);
      }}
    >
      <section
        className="payroll-workspace"
        aria-label="Monthly commission payroll"
      >
        <div className="payroll-heading">
          <div>
            <h2>{target.intakeId ? target.intakeReference ?? "Selected statement" : "Payroll cycles & history"}</h2>
            <p className="muted">
              Review commissions, approve payroll, and track delivery through
              payment.
            </p>
          </div>
          <Button
            variant="secondary"
            disabled={resource.loading}
            onClick={() => void resource.refetch()}
          >
            Refresh payroll
          </Button>
        </div>
        {resource.error && (
          <p role="alert" className="error-text">
            {resource.error}
          </p>
        )}
        {!data ? (
          !resource.error && <p>Loading payroll…</p>
        ) : (
          <>
            {owner && target.intakeId && <><CommissionJourney nextStep={journeyStep} activeStep={inspectedStep ?? journeyStep} choose={chooseJourneyStep} /><p className="commission-notice">Statement and carrier payment complete. {journeyStep === 4 ? "Next: review the earnings and payroll dates before approving." : journeyStep === 5 ? "Payroll approved. Next: inspect the reports and record actual employee payment." : "Employee payment complete. The payment history remains available below."}</p>{!handoff && <Button variant="secondary" onClick={() => navigate({...target,cycleId:undefined})}>Review this statement’s payroll selection</Button>}</>}
            {owner && handoff && source && <SourcePayrollSelection source={source} workspace={data.workspace} refresh={refresh} />}
            {!handoff && <>
            {owner && !source && !!cycles.length && <label className="field payroll-cycle-picker">
              <span>Review payroll cycle</span>
              <Select value={focused?.id ?? ""} onChange={e => requestLeave(() => setSelectedCycle(e.target.value))}>
                {cycles.map(c => <option key={c.id} value={c.id}>{displayMonth(c.id)} · {c.cycleType === "OFF_CYCLE" ? "Off-cycle" : "Monthly"} · {c.status.toLowerCase()}</option>)}
              </Select>
              <small className="muted">One cycle at a time. Earlier reports and payment history remain available.</small>
            </label>}
            {owner && <PayrollReadiness workspace={data.workspace} cycle={focused} reviewStatements={reviewStatements} />}
            <details open={source ? undefined : true}><summary>Other payroll cycles, history & settings</summary>
            <Panel title="Search payroll history" hint="Find completed cycles by date, employee, reference or status">
              <label className="field">Find a payroll cycle<Input type="search" value={historyQuery} onChange={e=>setHistoryQuery(e.target.value)} /></label>
              {cycles.filter(c=>c.status!=='OPEN' && (c.id+' '+c.status+' '+c.payDate+' '+(c.paymentReference??'')+' '+data.workspace.batches.filter(b=>c.batchIds.includes(b.id)).map(b=>b.producerName).join(' ')).toLowerCase().includes(historyQuery.toLowerCase())).map(c=><div className="commission-work-item" key={c.id}><span>{c.id} · {c.status.toLowerCase()} · {money(c.totalCents)}</span><Button variant="secondary" onClick={()=>requestLeave(()=>setSelectedCycle(c.id))}>Review {c.id}</Button></div>)}
            </Panel>
            <div className="payroll-tools">
              {owner && data.workspace.settings && (
                <Panel
                  title="Report delivery settings"
                  hint={
                    data.workspace.settings.enabled
                      ? "Automatic delivery enabled"
                      : "Automatic delivery off"
                  }
                >
                  <SettingsForm
                    key={data.workspace.settings.version}
                    settings={data.workspace.settings}
                    environment={data.workspace.environment}
                    refresh={refresh}
                  />
                </Panel>
              )}
              {owner && (
                <Panel
                  title="Add a payroll month"
                  hint="Set the monthly cutoff and pay dates"
                >
                  <CycleForm refresh={refresh} />
                </Panel>
              )}
              {owner && (
                <Panel
                  open={!!target.earningKeys?.length}
                  title="Add an off-cycle payment"
                  hint="Create a supplemental employee run"
                >
                  <OffCycleForm
                    key={JSON.stringify(target.earningKeys ?? [])}
                    initialKeys={target.earningKeys}
                    initialProducer={target.producerId}
                    onCreated={id=>{setSelectedCycle(id);navigate({tab:"payroll",cycleId:id});}}
                    producers={data.workspace.producers ?? []}
                    earnings={data.workspace.availableEarnings ?? []}
                    refresh={refresh}
                  />
                </Panel>
              )}
            </div></details>
            {owner &&
              !data.workspace.cycles.some(
                (c) => c.id === COMMISSION_START_MONTH,
              ) && (
                <Action
                  label="Create calendars from October 2026"
                  refresh={refresh}
                  action={() =>
                    commissionAction("initializePayrollCalendar", {})
                  }
                >
                  <p>
                    Creates missing monthly calendars from October 2026 through
                    next month. Review historical payments and scheduled dates
                    before approval. Delivery remains off until enabled.
                  </p>
                </Action>
              )}
            {!!data.workspace.legacyBatches?.length && (
              <p role="alert">
                Unpaid legacy batches need review. Cancel an unpaid legacy batch
                below to release its earnings, then include them in a reviewed
                monthly or off-cycle report. Do not cancel a batch that has
                actually been paid.
              </p>
            )}
            {!data.workspace.cycles.length && (
              <div className="payroll-empty">
                <strong>No payroll months yet</strong>
                <p>Add a month above to prepare the first commission review.</p>
              </div>
            )}
            {!data.workspace.cycles.some(
              (c) =>
                c.id === payrollDay().slice(0, 7) && c.status !== "CANCELLED",
            ) && (
              <p role="alert">
                This month's commission payroll calendar is missing. Add the
                actual cutoff, processing, delivery, and pay dates to schedule
                the report.
              </p>
            )}
            {(owner ? (focused ? [focused] : []) : cycles).map((c) => (
              <CycleCard
                key={`${c.id}:${c.version}`}
                cycle={c}
                workspace={data.workspace}
                owner={owner}
                refresh={refresh}
                guided={!!target.intakeId}
              />
            ))}
            <CommissionPanel title="Report delivery history" hint="Delivery evidence for the selected cycle" open={selectedDeliveries.some(d=>d.status==='FAILED'||d.status==='UNKNOWN'||!!d.failureState)}>
            <section
              id="payroll-delivery-history"
              className="payroll-history"
              aria-label="Report delivery history"
            >
              <div className="payroll-section-heading">
                <div>
                  <h3>Report delivery history</h3>
                  <p className="small muted">
                    Email acceptance and payment confirmation are tracked
                    separately.
                  </p>
                </div>
                <span className="badge gray">
                  {selectedDeliveries.length} deliveries
                </span>
              </div>
              {!selectedDeliveries.length && (
                <div className="payroll-empty">No reports have been sent.</div>
              )}
              {selectedDeliveries.map((d) => (
                <div className="payroll-delivery" key={d.id + ":" + d.version}>
                  <div className="payroll-section-heading">
                    <strong>
                      {displayMonth(d.cycleId)} ·{" "}
                      {d.reportType.replaceAll("_", " ").toLowerCase()}
                    </strong>
                    <StatusBadge status={d.status} />
                  </div>
                  <p>
                    {d.recipient}{" "}
                    <span className="muted">
                      · {new Date(d.updatedAt).toLocaleString()}
                    </span>
                  </p>
                  {d.error && <p role="alert">{d.error}</p>}
                  <p className="small">
                    Revision {d.cycleRevision}
                    {d.messageId ? ` · Email service ID ${d.messageId}` : ""}
                    {d.sourceDeliveryId ? " · Owner escalation copy" : ""}
                  </p>
                  {!!d.feedback?.length && (
                    <p>
                      Email feedback: {d.feedback.join(", ")}
                      {d.feedbackObservedAt
                        ? ` · Checked ${new Date(d.feedbackObservedAt).toLocaleString()}`
                        : ""}
                    </p>
                  )}
                  {owner && d.status === "FAILED" && (
                    <Action
                      label="Retry the same unsent report"
                      refresh={refresh}
                      action={() =>
                        commissionAction("retryPayrollDelivery", {
                          id: d.id,
                          version: d.version,
                        })
                      }
                    />
                  )}
                </div>
              ))}
            </section></CommissionPanel>
            {owner && <ReportHistory workspace={{...data.workspace,reports:data.workspace.reports?.filter(r=>!focused||r.cycleId===focused.id)}} />}
            {owner && (
              <>
                <Button
                  variant="secondary"
                  onClick={() => setAuditOpen((v) => !v)}
                >
                  {auditOpen ? "Close audit history" : "View audit history"}
                </Button>
                {auditOpen && <AuditHistory />}
              </>
            )}
            </>}
          </>
        )}
      </section>
    </PayrollAccessContext.Provider>
  );
}
function SourcePayrollSelection({ source, workspace, refresh }: { source: ReturnType<typeof sourcePayrollHandoff>; workspace: PayrollWorkspace; refresh: () => Promise<void> }) {
  const { target, navigate } = useCommissionWorkflow();
  const [prepare, setPrepare] = useState(false);
  const total = sum(source.available.map(e => e.amountCents));
  const month = [payrollDay().slice(0,7), source.latestReceipt?.slice(0,7) ?? ""].sort().at(-1)!;
  const suggested = source.monthly ?? suggestPayrollDates(month);
  const dates = { id: suggested.id.slice(0,7), cutoff: suggested.cutoff, reviewOn: suggested.reviewOn, hrDueOn: suggested.hrDueOn, processingOn: suggested.processingOn, payDate: suggested.payDate };
  return <section className="card" aria-label="Statement payroll selection">
    <h3>Review payroll for this statement</h3>
    <p>Policy matches, employee rates and receipt dates carry forward from the posted statement. Review the proposed earnings and schedule; creating a draft does not approve or pay them.</p>
    {!!source.available.length && <>
      <strong>{source.available.length} available earnings · {money(total)}</strong>
      {!prepare && <div className="commission-scroll"><Table><thead><tr><th>Employee / policy</th><th>Actual carrier receipt</th><th>Employee commission</th></tr></thead><tbody>{source.available.map(e => <tr key={payrollRowKey(e)}><td>{e.producerName}<div className="small muted">{e.policyNumber} · {e.producerBps / 100}%{e.shareBps !== undefined ? ` · ${e.shareBps / 100}% share` : ""}</div></td><td>{displayDate(e.receivedOn)}</td><td>{money(e.amountCents)}</td></tr>)}</tbody></Table></div>}
    </>}
    {source.linkedCycles.map(c => <div className="commission-work-item" key={c.id}><span>{c.id} · {c.status.toLowerCase()} · full cycle {money(c.preview?.totalCents ?? c.totalCents)}</span><Button variant="secondary" onClick={() => navigate({...target,cycleId:c.id})}>Review linked payroll {c.id}</Button></div>)}
    {!source.available.length && <p>{source.linkedCycles.length ? "These earnings are already assigned. Continue with a linked payroll cycle above." : "No available earnings are linked to this statement. Review eligibility and the ledger before preparing payroll."}</p>}
    {!!source.keys.length && <>
      {!prepare && <Button variant="primary" onClick={() => setPrepare(true)}>{source.linkedCycles.length ? "Prepare another draft for these earnings" : "Prepare payroll for these earnings"}</Button>}
      {prepare && <><h4>Confirm the suggested payroll draft</h4><p>Only this statement’s {source.keys.length} earnings are preselected. Dates come from {source.monthly ? "the next matching monthly calendar" : "the standard monthly schedule"}; the proposed schedule below shows when approval opens. You can use the last selected receipt date for an earlier cutoff, then review the remaining dates before saving.</p><OffCycleForm key={JSON.stringify(source.keys)} initialKeys={source.keys} initialReason={"Statement " + (target.intakeReference ?? target.intakeId)} initialDates={dates} producers={workspace.producers ?? []} earnings={workspace.availableEarnings ?? []} refresh={refresh} onCreated={id => navigate({...target,cycleId:id})} /></>}
      {source.monthly && <details><summary>Include in the regular monthly payroll instead</summary><p>The monthly cycle includes other eligible earnings. Review its full amount of {money(source.monthly.preview?.totalCents ?? source.monthly.totalCents)} and all employees before approval.</p><Button variant="secondary" onClick={() => navigate({...target,cycleId:source.monthly!.id})}>Review monthly payroll {source.monthly.id}</Button></details>}
    </>}
  </section>;
}

function PayrollReadiness({ workspace, cycle, reviewStatements }: { workspace: PayrollWorkspace; cycle?: PayrollCycle; reviewStatements?: () => void }) {
  const readiness = workspace.statementReadiness;
  if (!cycle || !readiness) return null;
  const approvalIssues = payrollApprovalIssues(cycle);
  const cutoffWait = cycle.status === 'OPEN' ? payrollCutoffIssue(cycle) : '';
  const reviewIssues = approvalIssues.filter(issue => issue !== cutoffWait);
  const pending = readiness.pendingSettlements.filter(s => s.receivedOn <= cycle.cutoff);
  const batches = workspace.batches.filter(b => cycle.batchIds.includes(b.id));
  const paid = sum(batches.map(batchPaidCents));
  const deliveries = workspace.deliveries.filter(d => d.cycleId === cycle.id && d.cycleRevision === cycle.revision && d.reportType === 'PAYROLL');
  const failures = deliveries.filter(d => d.status === 'FAILED' || d.status === 'UNKNOWN' || !!d.failureState);
  const delivery = failures.length ? 'Needs delivery review' : deliveries.some(d => d.status === 'SENT') ? 'Accepted by email service' : deliveries.some(d => d.status === 'SENDING') ? 'Sending' : 'Not sent';
  return <section className="card payroll-readiness" aria-label="Payroll readiness">
    <div className="payroll-heading"><div><h3>Payroll readiness</h3><p className="muted">Receipts through {displayDate(cycle.cutoff)} · HR due {displayDate(cycle.hrDueOn)} · pay date {displayDate(cycle.payDate)}</p></div></div>
    <div className="payroll-readiness-grid">
      <div><span>Statement preparation</span><strong>{readiness.statementsNeedingReview} to review</strong><small>{readiness.unmatchedRows} unmatched rows · {readiness.activeStatements} active statements</small></div>
      <div><span>Received by cutoff</span><strong>{pending.length} settlements to post</strong><small>Unpaid statements do not block payroll</small></div>
      <div><span>{cycle.status === 'OPEN' ? 'Eligible earnings in preview' : 'Approved commission'}</span><strong>{money(cycle.preview?.totalCents ?? cycle.totalCents)}</strong><small>{reviewIssues.length ? reviewIssues.length + ' review item' + (reviewIssues.length === 1 ? '' : 's') + ' to resolve' : cutoffWait ? 'No reconciliation issues' : cycle.status === 'OPEN' ? 'Ready for Owner review' : 'Revision ' + cycle.revision}</small></div>
      <div><span>Approval</span><strong>{cycle.status === 'OPEN' ? reviewIssues.length ? 'Needs review' : cutoffWait ? 'Waiting for cutoff' : 'Ready for your approval' : cycle.status.toLowerCase()}</strong><small>{reviewIssues[0] ?? (cutoffWait ? 'Approval opens ' + approvalOpensOn(cycle.cutoff) + ' after the inclusive receipt cutoff ends.' : 'Review the selected cycle')}</small></div>
      <div><span>Report delivery</span><strong>{delivery}</strong><small>Delivery is separate from approval and payment</small></div>
      <div><span>Employee payment</span><strong>{money(paid)} paid</strong><small>{money(Math.max(0,cycle.totalCents-paid))} approved balance</small></div>
    </div>
    {!!pending.length && <p className="commission-notice">Finish posting: {pending.slice(0, 3).map(s => s.reference).join('; ')}{pending.length > 3 ? ' and ' + (pending.length - 3) + ' more' : ''}.</p>}
    {reviewStatements && !!pending.length && <Button variant="secondary" onClick={reviewStatements}>Review statements awaiting posting</Button>}
    <p className="small muted">Review this selected cycle for eligibility exceptions, approval, report versions, delivery evidence and payment confirmation.</p>
  </section>;
}

function Action({
  label,
  action,
  refresh,
  children,
  disabled = false,
  secondaryAction,
  disabledReason,
}: {
  label: string;
  action: () => Promise<unknown>;
  refresh: () => Promise<void>;
  children?: ReactNode;
  disabled?: boolean;
  secondaryAction?: ReactNode;
  disabledReason?: string;
}) {
  const invalidate = useContext(PayrollAccessContext);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  const lock = useRef(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await action();
      await refresh();
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Payroll action failed.");
      if (isAuthorizationError(e)) invalidate(e);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <form
      className="payroll-action"
      onSubmit={(e) => void submit(e)}
      aria-busy={busy}
    >
      <fieldset disabled={busy}>
        {children && <div className="payroll-form-body">{children}</div>}
        <div className="payroll-form-footer commission-action-bar">
          <Button
            type="submit"
            className={
              label.startsWith("Download")
                ? "secondary"
                : label.startsWith("Cancel")
                  ? "secondary payroll-danger-button"
                  : "primary"
            }
            disabled={disabled}
          >
            {busy ? "Working…" : label}
          </Button>
          {secondaryAction}
          {disabled && disabledReason && <span className="small">{disabledReason}</span>}
          {saved && (
            <span className="payroll-saved" role="status">
              Saved.
            </span>
          )}
        </div>
      </fieldset>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
function LabeledInput({
  label,
  value,
  set,
  type = "text",
  required = true,
  readOnly = false,
}: {
  label: string;
  value: string;
  set: (v: string) => void;
  type?: string;
  required?: boolean;
  readOnly?: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <Input
        type={type}
        value={value}
        required={required}
        readOnly={readOnly}
        onChange={(e) => set(e.target.value)}
      />
    </label>
  );
}
function SettingsForm({
  settings,
  environment,
  refresh,
}: {
  settings: PayrollSettings;
  environment: string;
  refresh: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(settings),
    [saved, setSaved] = useState(false);
  useUnsavedChanges(
    !saved && JSON.stringify(draft) !== JSON.stringify(settings),
  );
  const update = (patch: Partial<PayrollSettings>) => {
    setSaved(false);
    setDraft((d) => ({ ...d, ...patch }));
  };
  return (
    <Action
      label="Save payroll settings"
      refresh={refresh}
      action={async () => {
        await commissionAction("savePayrollSettings", draft);
        setSaved(true);
      }}
    >
      <p>
        Approved commission reports are emailed to the HR inbox below. The
        recipient does not need to sign in or acknowledge the report in the CRM.
      </p>
      <div className="form-grid">
        <LabeledInput
          label="HR report email"
          type="email"
          required={draft.enabled}
          value={draft.hrRecipient}
          set={(v) => update({ hrRecipient: v })}
        />
        <LabeledInput
          label="Owner review & reminder email"
          type="email"
          required={draft.enabled}
          value={draft.reviewRecipient}
          set={(v) => update({ reviewRecipient: v })}
        />
      </div>
      <label className="payroll-check">
        <Input
          type="checkbox"
          checked={draft.enabled}
          disabled={environment !== "main"}
          onChange={(e) => update({ enabled: e.target.checked })}
        />{" "}
        Enable automatic report delivery
      </label>
      <p className="small muted">
        Delivery is off by default. When enabled in production, deadlines are
        checked hourly from 8 AM to 5 PM Eastern. Review notices go to the
        Owner; approved reports go to HR on the HR due date, or at the next
        check if approved late.
      </p>
      <p>
        HR receives a summary plus a separate PDF for each employee's personal
        pay file and enters commission amounts manually. No payroll employee
        IDs, earnings codes, or import template are needed.
      </p>
      <p>
        Bounced or rejected commission emails are copied individually to all
        active CRM Owners. Delivery history retains the original message, its
        report revision, and each Owner copy.
      </p>
    </Action>
  );
}
function CycleForm({
  cycle,
  refresh,
}: {
  cycle?: PayrollCycle;
  refresh: () => Promise<void>;
}) {
  const initial = cycle
    ? {
        id: cycle.id,
        version: cycle.version,
        cutoff: cycle.cutoff,
        reviewOn: cycle.reviewOn,
        hrDueOn: cycle.hrDueOn,
        processingOn: cycle.processingOn,
        payDate: cycle.payDate,
        reason: cycle.reason,
        producerIds: cycle.producerIds,
        selectedEarningKeys: cycle.selectedEarningKeys,
      }
    : { ...suggestPayrollDates(COMMISSION_START_MONTH), version: 0 };
  const [draft, setDraft] = useState(initial),
    [saved, setSaved] = useState(false),
    [dateError, setDateError] = useState("");
  useUnsavedChanges(
    !saved && JSON.stringify(draft) !== JSON.stringify(initial),
  );
  function suggestDates() {
    try {
      const dates = suggestPayrollDates(draft.id);
      setDraft((d) => ({ ...d, ...dates }));
      setSaved(false);
      setDateError("");
    } catch (error) {
      setDateError(
        error instanceof Error ? error.message : "Choose a payroll month.",
      );
    }
  }
  return (
    <Action
      label={cycle ? "Save payroll dates" : "Add payroll month"}
      refresh={refresh}
      action={async () => {
        await commissionAction("savePayrollCycle", draft);
        setSaved(true);
        if (!cycle) setDraft(initial);
      }}
    >
      <p>
        All employees share the same schedule: monthly commissions on the last
        regular Friday payday, processed Monday morning. Carrier receipts must
        arrive by EOD the preceding Friday. Approved reports are emailed Monday
        at 8 AM Eastern.
      </p>
      <p>
        Suggested dates include the Friday cutoff. Approval opens after that day
        ends. Any Owner can approve before Monday delivery; otherwise the report
        waits for approval and the configured Owner receives a reminder.
      </p>
      {cycle?.cycleType !== "OFF_CYCLE" && (
        <Button
          type="button"
          variant="secondary"
          disabled={!draft.id}
          onClick={suggestDates}
        >
          Use standard Friday cutoff and Monday report
        </Button>
      )}
      {dateError && <p role="alert">{dateError}</p>}
      <div className="form-grid">
        {(
          [
            ["id", "Payroll month", "month"],
            ["cutoff", "Receipts included through", "date"],
            ["reviewOn", "Owner review date", "date"],
            ["hrDueOn", "HR report due date", "date"],
            ["processingOn", "Payroll processing date", "date"],
            ["payDate", "Last regular pay date of month", "date"],
          ] as const
        ).map(([key, label, type]) => (
          <LabeledInput
            key={key}
            label={label}
            type={
              key === "id" && cycle?.cycleType === "OFF_CYCLE" ? "text" : type
            }
            readOnly={key === "id" && !!cycle}
            value={draft[key]}
            set={(v) => {
              setSaved(false);
              setDraft((d) => ({ ...d, [key]: v }));
            }}
          />
        ))}
      </div>
    </Action>
  );
}
function CycleCard({
  cycle: c,
  workspace,
  owner,
  refresh,
  guided = false,
}: {
  cycle: PayrollCycle;
  workspace: PayrollWorkspace;
  guided?: boolean;
  owner: boolean;
  refresh: () => Promise<void>;
}) {
  const { navigate } = useCommissionWorkflow();
  const issues = payrollApprovalIssues(c);
  const cutoffWait = c.status === 'OPEN' ? payrollCutoffIssue(c) : '';
  const reviewIssues = issues.filter(issue => issue !== cutoffWait);
  const [cancelOpen,setCancelOpen]=useState(false),[cancelConfirmed,setCancelConfirmed]=useState(false);
  const [confirmed, setConfirmed] = useState(false),
    [paidOn, setPaidOn] = useState(payrollDay()),
    [reference, setReference] = useState(""),
    [reason, setReason] = useState(""),
    [hrHeld, setHrHeld] = useState(false);
  const [reviewedToken,setReviewedToken] = useState<string>();
  useEffect(()=>{setConfirmed(false);setReviewedToken(undefined);},[c.preview?.token]);
  const approvalConfirmed = confirmed && !!reviewedToken && reviewedToken === c.preview?.token;
  useUnsavedChanges(c.status === 'OPEN' && confirmed);
  const paidCents = sum(
    workspace.batches
      .filter((b) => c.batchIds.includes(b.id))
      .map(batchPaidCents),
  );
  const deliveryIssue=workspace.deliveries.some(d=>d.cycleId===c.id&&d.cycleRevision===c.revision&&(d.status==='FAILED'||d.status==='UNKNOWN'||!!d.failureState));
  const nextLabel=reviewIssues.length?'Resolve next review item':cutoffWait?'Review payroll dates':c.status==='OPEN'?'Review approval':deliveryIssue?'Review delivery issue':c.status==='APPROVED'&&paidCents>0?'Record remaining payment':c.status==='APPROVED'?'Inspect approved reports':c.status==='CANCELLED'?'Prepare replacement cycle':'Review payment history';
  const resolveIssue = (message: string) => {
    const destination = c.preview?.issues?.find(issue => issue.message === message)?.target;
    if (message.startsWith('Selected off-cycle') || destination?.tab === 'payroll' && destination.cycleId === c.id) {
      openPayrollDates(c.id);
      return true;
    }
    if (destination) { navigate(destination); return true; }
    return false;
  };
  const nextReview=()=>{
    if (reviewIssues.length && resolveIssue(reviewIssues[0])) return;
    if (!reviewIssues.length && cutoffWait) { openPayrollDates(c.id); return; }
    const root=document.getElementById('payroll-cycle-'+c.id);
    const node=reviewIssues.length?root?.querySelector('[role=alert]'):deliveryIssue?document.getElementById('payroll-delivery-history'):c.status==='OPEN'?root?.querySelector('.payroll-cycle-actions'):document.getElementById((c.status==='CANCELLED'?'payroll-replace-':c.status==='PAID'||paidCents>0?'payroll-payments-':'payroll-reports-')+c.id);
    let parent=node; while(parent){if(parent.tagName==='DETAILS')(parent as HTMLDetailsElement).open=true;parent=parent.parentElement;}
    node?.scrollIntoView?.({block:'start'}); (node?.querySelector('button,input,summary') as HTMLElement|null)?.focus({preventScroll:true});
  };
  const canCancel=owner && ['OPEN','APPROVED'].includes(c.status) && paidCents===0 && !workspace.deliveries.some(d=>d.cycleId===c.id&&d.cycleRevision===c.revision&&d.reportType==='PAYROLL');
  const rows =
    c.status === "OPEN"
      ? (c.preview?.employees ?? [])
      : workspace.batches
          .filter((b) => c.batchIds.includes(b.id))
          .map((b) => ({
            producerId: b.producerId,
            name: b.producerName,
            amountCents: b.totalCents,
          }));
  async function download(documentId: string) {
    await downloadReport({
      id: c.id,
      documentId,
      ...(c.status === "PAID" ? { historicalConfirmed: true } : {}),
    });
  }
  return (
    <section
      id={"payroll-cycle-"+c.id}
      className="card payroll-cycle"
      aria-label={
        displayMonth(c.id) +
        (c.cycleType === "OFF_CYCLE" ? " off-cycle" : " monthly") +
        " payroll"
      }
    >
      <div className="payroll-cycle-heading">
        <div>
          <p className="payroll-eyebrow">
            {c.cycleType === "OFF_CYCLE"
              ? "Off-cycle payroll"
              : "Monthly commission payroll"}
          </p>
          <h3>{displayMonth(c.id)}</h3>
          <span className="small muted">
            {c.id} · Revision {c.revision}
          </span>
        </div>
        <StatusBadge status={c.status} />
      </div>
      <dl className="payroll-dates">
        {(
          [
            ["Receipt cutoff", c.cutoff],
            ["Owner review", c.reviewOn],
            ["HR report due", c.hrDueOn],
            ["Processing", c.processingOn],
            ["Pay date", c.payDate],
          ] as const
        ).map(([label, value]) => (
          <div
            key={label}
            className={label === "Pay date" ? "payroll-date-pay" : ""}
          >
            <dt>
              {label}
              {label === "Receipt cutoff" && (
                <span className="payroll-inclusive"> · inclusive</span>
              )}
            </dt>
            <dd>{displayDate(value)}</dd>
          </div>
        ))}
      </dl>
      {c.status === "OPEN" && (
        <p className="small muted">
          Preview includes currently reconciled, eligible, unbatched receipts
          through the cutoff. Unentered carrier receipts are not included.
        </p>
      )}
      {c.reviewRequired && <p role="alert">{c.reviewRequired}</p>}
      {(c.reason || c.replacesRevision) && (
        <p className="payroll-context">
          {c.cycleType === "OFF_CYCLE" ? c.reason : ""}
          {c.replacesRevision
            ? " Replaces revision " +
              c.replacesRevision +
              ": " +
              c.correctionReason
            : ""}
        </p>
      )}
      {["APPROVED", "PAID"].includes(c.status) && (
        <div className="payroll-balances">
          <span>
            Recorded paid <strong>{money(paidCents)}</strong>
          </span>
          <span>
            Outstanding <strong>{money(c.totalCents - paidCents)}</strong>
          </span>
        </div>
      )}
      {c.status === "OPEN" && !!cutoffWait && <PayrollScheduleNotice cutoff={c.cutoff} />}
      {c.status === "OPEN" && !!reviewIssues.length && (
        <div className="payroll-notice" role="alert">
          <strong>Resolve before approval</strong>
          <ul>
            {reviewIssues.map((b) => {
              const issue=c.preview?.issues?.find(i=>i.message===b);
              return <li key={b}>{b} {(issue?.target || b.startsWith("Selected off-cycle")) && <Button variant="secondary" onClick={()=>resolveIssue(b)}>{issue?.target?.tab === "statements" ? "Open statement to resolve" : issue?.target?.tab === "payroll" || b.startsWith("Selected off-cycle") ? "Review selected earnings" : "Open review item"}</Button>}</li>;
            })}
          </ul>
        </div>
      )}
      {c.status === "OPEN" && c.preview?.entryCount === 0 && (
        <p>
          No payable commissions are currently recorded. Approve a zero report
          only after checking that all carrier receipts have been reconciled.
        </p>
      )}
      <div className="commission-action-bar"><Button variant="secondary" onClick={nextReview}>{nextLabel}</Button></div>
      <p className="commission-notice">Next: {reviewIssues.length?'open and resolve the listed review items':cutoffWait?'review the payroll dates, or return on ' + approvalOpensOn(c.cutoff):c.status==='OPEN'?'review calculations and approve this cycle':c.status==='APPROVED'?'inspect approved reports, review delivery, then record actual employee payments':c.status==='PAID'?'review payment history':'select another cycle or prepare a replacement'}.</p>
      <div className="commission-scroll payroll-totals">
        <Table aria-label={"Employee totals for " + c.id}>
          <thead>
            <tr>
              <th scope="col">Employee</th>
              <th scope="col" className="payroll-money">
                Commission
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.producerId}>
                <td>{r.name}</td>
                <td className="payroll-money">{money(r.amountCents)}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={2} className="muted">
                  No payable employee earnings in this cycle.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Total commission</th>
              <td className="payroll-money">
                {money(sum(rows.map((r) => r.amountCents)))}
              </td>
            </tr>
          </tfoot>
        </Table>
      </div>
      <EmployeeCalculations cycle={c} workspace={workspace} />
      <div className="payroll-cycle-actions">
      {owner && c.status === "OPEN" && (
        <>
          <Panel id={'payroll-edit-' + c.id} title={c.cycleType === 'OFF_CYCLE' ? 'Edit off-cycle dates and earnings' : 'Edit payroll dates'}>
            {c.cycleType === 'OFF_CYCLE'
              ? <OffCycleForm cycle={c} producers={workspace.producers??[]} earnings={workspace.availableEarnings??[]} refresh={refresh} />
              : <CycleForm cycle={c} refresh={refresh} />}
          </Panel>
          <Action
            label="Approve payroll cycle"
            disabled={!approvalConfirmed || !c.preview || !!issues.length}
            disabledReason={reviewIssues.length ? 'Resolve ' + reviewIssues.length + ' review item' + (reviewIssues.length===1?'':'s') + ' before approval.' : cutoffWait ? 'Approval opens ' + approvalOpensOn(c.cutoff) + '. Review payroll dates above to make a correction.' : !approvalConfirmed ? 'Confirm the review above before approval.' : 'Refresh the payroll preview.'}
            secondaryAction={canCancel && <Button type="button" variant="danger" className="payroll--button" onClick={()=>setCancelOpen(true)}>Cancel cycle…</Button>}
            refresh={refresh}
            action={() => {
              if (!approvalConfirmed) throw new Error('Review and confirm the current payroll amounts before approval.');
              return commissionAction("approvePayrollCycle", {
                id: c.id,
                version: c.version,
                previewToken: reviewedToken,
                confirmed: approvalConfirmed,
              });
            }}
          >
            <label className="payroll-check">
              <Input
                type="checkbox"
                checked={approvalConfirmed}
                onChange={(e) => {setConfirmed(e.target.checked);setReviewedToken(e.target.checked?c.preview?.token:undefined);}}
              />{" "}
              I reviewed carrier receipts, fees received, eligibility, employee totals, prior
              commission payments, and payroll dates.
            </label>
          </Action>
        </>
      )}
      {canCancel && c.status==='APPROVED' && <Button variant="danger" className="payroll--button" onClick={()=>setCancelOpen(true)}>Cancel cycle…</Button>}
      {cancelOpen && <Modal className="modal-form commission-cancel-modal" title="Cancel unpaid payroll cycle" onClose={()=>setCancelOpen(false)}>
        <Action label="Cancel payroll cycle" disabled={!cancelConfirmed || !reason.trim()} refresh={async()=>{setCancelOpen(false);await refresh();}} action={()=>commissionAction('cancelPayrollCycle',{id:c.id,version:c.version,reason})}>
          <p>This releases this unpaid cycle's reserved earnings. Approval and audit history remain available.</p>
          <LabeledInput label="Cancellation reason" value={reason} set={setReason} />
          <label className="payroll-check"><Input type="checkbox" checked={cancelConfirmed} onChange={e=>setCancelConfirmed(e.target.checked)} />I confirm this cycle is unpaid and should be cancelled.</label>
        </Action>
      </Modal>}
      </div>
      {["APPROVED", "PAID"].includes(c.status) && (
        <Action
          label="Download HR summary PDF"
          disabled={!!c.reviewRequired}
          action={() => download("summary")}
          refresh={async () => {}}
        />
      )}
      {["APPROVED", "PAID"].includes(c.status) && (
        <Panel id={"payroll-reports-"+c.id} title="Employee pay-file documents">
          {workspace.batches
            .filter((b) => c.batchIds.includes(b.id))
            .map((b) => (
              <Action
                key={b.id}
                label={`Download ${b.producerName} earnings PDF`}
                disabled={!!c.reviewRequired}
                action={() => download(b.id)}
                refresh={async () => {}}
              />
            ))}
        </Panel>
      )}
      {c.status === "APPROVED" && (!c.reviewRequired || paidCents > 0) && (
        <>
          <Panel id={"payroll-payments-"+c.id} title="Record individual employee payments" open={guided}>
            <p>
              Record the amount actually paid, including partial payments. The
              remaining balance stays open until every employee is fully paid.
            </p>
            {workspace.batches
              .filter((b) => c.batchIds.includes(b.id))
              .map((b) => (
                <EmployeePayment
                  key={`${b.id}:${b.version}`}
                  cycle={c}
                  batch={b}
                  refresh={refresh}
                />
              ))}
          </Panel>
          <Panel title="Confirm completed payroll payment">
            <Action
              label="Confirm full cycle paid"
              disabled={!confirmed}
              refresh={refresh}
              action={() =>
                commissionAction("confirmPayrollCycle", {
                  id: c.id,
                  version: c.version,
                  paidOn,
                  paymentReference: reference,
                  confirmed,
                })
              }
            >
              <LabeledInput
                label="Actual payment date"
                type="date"
                value={paidOn}
                set={setPaidOn}
              />
              <LabeledInput
                label="Payroll confirmation reference"
                value={reference}
                set={setReference}
              />
              <label className="payroll-check">
                <Input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />{" "}
                Every amount in this cycle has been paid. Exporting or
                submitting payroll alone does not confirm payment.
              </label>
            </Action>
          </Panel>
        </>
      )}
      {c.status === "PAID" && (
        <p>
          Paid {c.paidOn} · Reference: {c.paymentReference}
        </p>
      )}
      {owner && c.status === "CANCELLED" && (
        <Panel id={"payroll-replace-"+c.id} title="Prepare a replacement cycle">
          <CycleForm cycle={c} refresh={refresh} />
        </Panel>
      )}
      {c.status === "PAID" && (
        <Panel id={"payroll-payments-"+c.id} title="Employee payment history">
          {workspace.batches
            .filter((b) => c.batchIds.includes(b.id))
            .map((b) => (
              <EmployeePayment
                key={b.id}
                cycle={c}
                batch={b}
                refresh={refresh}
              />
            ))}
        </Panel>
      )}
      {owner && c.status === "APPROVED" && paidCents === 0 && (
        <Panel title="Correct an unpaid report">
          <Action
            label="Reopen as a new revision"
            refresh={refresh}
            action={() =>
              commissionAction("reopenPayrollCycle", {
                id: c.id,
                version: c.version,
                reason,
                hrHeld,
              })
            }
          >
            <p>
              The original PDFs and approval remain in history. Recorded
              payments and uncertain email sends prevent replacement. Correct
              the ledger after reopening, then review and approve the new
              revision.
            </p>
            <LabeledInput
              label="Report correction reason"
              value={reason}
              set={setReason}
            />
            <label className="payroll-check">
              <Input
                type="checkbox"
                checked={hrHeld}
                onChange={(e) => setHrHeld(e.target.checked)}
              />{" "}
              HR has held the original report and no employee has been paid.
              Required if the report was sent.
            </label>
          </Action>
        </Panel>
      )}
      {owner && c.status === "APPROVED" && paidCents > 0 && (
        <p className="small">
          Recorded payments prevent replacing or cancelling this report. Keep
          this payment history and review any additional eligible earnings in a
          supplemental cycle.
        </p>
      )}
    </section>
  );
}
function EmployeePayment({
  cycle,
  batch,
  refresh,
}: {
  cycle: PayrollCycle;
  batch: CommissionBatch;
  refresh: () => Promise<void>;
}) {
  const [confirmed, setConfirmed] = useState(false),
    [paidOn, setPaidOn] = useState(payrollDay()),
    [reference, setReference] = useState("");
  const balance = batch.totalCents - batchPaidCents(batch);
  const [amount, setAmount] = useState((balance / 100).toFixed(2)),
    [paymentId] = useState(() => crypto.randomUUID());
  const history = (
    <>
      <p>
        {batch.producerName}: approved {money(batch.totalCents)} · paid{" "}
        {money(batchPaidCents(batch))} · remaining {money(balance)}
      </p>
      {batch.payments?.map((p) => (
        <p className="small" key={p.id}>
          {p.paidOn} · {money(p.amountCents)} · {p.reference} · Recorded{" "}
          {new Date(p.recordedAt).toLocaleString()}
        </p>
      ))}
    </>
  );
  if (batch.status === "PAID")
    return (
      <div>
        {history}
        <p>Fully paid {batch.actualPaidOn}.</p>
      </div>
    );
  return (
    <Action
      label={`Record payment for ${batch.producerName}`}
      disabled={!confirmed}
      refresh={refresh}
      action={() =>
        commissionAction("confirmPayrollEmployee", {
          id: cycle.id,
          version: cycle.version,
          batchId: batch.id,
          paymentId,
          amountCents: decimal(amount),
          paidOn,
          paymentReference: reference,
          confirmed,
        })
      }
    >
      {history}
      <LabeledInput
        label={`Amount paid to ${batch.producerName} (USD)`}
        value={amount}
        set={setAmount}
      />
      <LabeledInput
        label={`Payment date for ${batch.producerName}`}
        type="date"
        value={paidOn}
        set={setPaidOn}
      />
      <LabeledInput
        label={`Payment reference for ${batch.producerName}`}
        value={reference}
        set={setReference}
      />
      <label className="payroll-check">
        <Input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />{" "}
        I verified this amount was actually paid.
      </label>
    </Action>
  );
}

async function downloadReport(input: Record<string, unknown>) {
  const result = await commissionAction<{
    files: { filename: string; content: string; contentType: string }[];
  }>("downloadPayrollCycle", input);
  const files = result.files.map((f) => ({
    ...f,
    bytes: Uint8Array.from(atob(f.content), (char) => char.charCodeAt(0)),
  }));
  const blob =
    files.length === 1
      ? new Blob([files[0].bytes], { type: files[0].contentType })
      : new Blob(
          [
            new Uint8Array(
              zipSync(
                Object.fromEntries(files.map((f) => [f.filename, f.bytes])),
              ),
            ),
          ],
          { type: "application/zip" },
        );
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download =
    files.length === 1
      ? files[0].filename
      : `Commission_${input.id}_v${input.revision}_archive.zip`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function OffCycleForm({
  cycle,
  producers,
  earnings,
  refresh,
  initialKeys, initialProducer, initialReason, initialDates, onCreated,
}: {
  producers: { id: string; name: string }[];
  initialKeys?: string[]; initialProducer?: string; initialReason?: string; initialDates?: ReturnType<typeof suggestPayrollDates>; onCreated?: (id: string) => void;
  cycle?: PayrollCycle;
  earnings: NonNullable<PayrollWorkspace['availableEarnings']>;
  refresh: () => Promise<void>;
}) {
  const [dates, setDates] = useState(
      cycle ? { id: cycle.id, cutoff: cycle.cutoff, reviewOn: cycle.reviewOn, hrDueOn: cycle.hrDueOn, processingOn: cycle.processingOn, payDate: cycle.payDate } : initialDates ?? suggestPayrollDates(payrollDay().slice(0, 7)),
    ),
    [reason, setReason] = useState(cycle?.reason ?? initialReason ?? ""),
    [producerIds, setProducers] = useState<string[]>(cycle?.producerIds ?? (initialProducer ? [initialProducer] : [...new Set(earnings.filter(e=>initialKeys?.includes(payrollRowKey(e))).map(e=>e.producerId))])),
    [requestId, setRequestId] = useState(() => crypto.randomUUID().slice(0, 8));
  const [selection, setSelection] = useState<string[] | undefined>(cycle?.selectedEarningKeys ?? initialKeys);
  const [changeSelection, setChangeSelection] = useState(!initialReason && !cycle?.selectedEarningKeys);
  const available = earnings.filter(e => producerIds.includes(e.producerId) && e.receivedOn <= dates.cutoff);
  const selected = available.filter(e => !selection || selection.includes(payrollRowKey(e)));
  const stale = !!selection?.some(key => !available.some(e => payrollRowKey(e) === key));
  const latestReceipt = selected.map(row => row.receivedOn).sort().at(-1);
  const draftState=JSON.stringify({ dates, reason, producerIds, selection });
  const initialState=useRef(draftState);
  const protection = useUnsavedChanges(draftState !== initialState.current);
  return (
    <Action
      label={cycle ? "Save off-cycle draft" : initialReason ? "Create payroll draft" : "Create off-cycle draft"}
      disabled={!producerIds.length || (selection !== undefined && (!selection.length || stale))}
      refresh={refresh}
      action={async () => {
        await commissionAction("savePayrollCycle", {
          ...dates,
          id: cycle?.id ?? `${dates.payDate.slice(0, 7)}-OFF-${requestId}`,
          version: cycle?.version ?? 0,
          reason,
          producerIds,
          ...(selection ? { selectedEarningKeys: selection } : {}),
        });
        protection?.markClean();
        if (!cycle) {
          initialState.current = JSON.stringify({ dates, reason: "", producerIds: [], selection: undefined });
          setReason("");
          setProducers([]);
          setSelection(undefined);
          setRequestId(crypto.randomUUID().slice(0, 8));
          onCreated?.(dates.payDate.slice(0,7)+"-OFF-"+requestId);
        }
      }}
    >
      {!changeSelection && <Button type="button" variant="secondary" onClick={() => setChangeSelection(true)}>Change employees or earnings</Button>}
      {changeSelection && <><p>Choose employees, then include all available earnings or select specific receipts and adjustments. Earnings reserved by another approved cycle are excluded.</p>
      <div className="payroll-people">
        {producers.map((p) => (
          <label className="payroll-check payroll-person" key={p.id}>
            <Input
              type="checkbox"
              checked={producerIds.includes(p.id)}
              onChange={(e) => { const checked = e.target.checked; setProducers(ids => checked ? [...ids, p.id] : ids.filter(id => id !== p.id)); }}
            />{" "}
            {p.name}
          </label>
        ))}
      </div>
      {!producers.length && (
        <p>No employees with commission policy records are available yet.</p>
      )}
      <label className="field">Earnings to include
        <Select value={selection === undefined ? 'all' : 'selected'} onChange={e => setSelection(e.target.value === 'all' ? undefined : [])}>
          <option value="all">All eligible earnings through the cutoff</option>
          <option value="selected">Choose specific earnings</option>
        </Select>
      </label>
      </>}
      {!!producerIds.length && <div className="payroll-selection">
        <div className="commission-section-heading"><div><strong>{selected.length} earnings · {money(sum(selected.map(e => e.amountCents)))}</strong><p className="small muted">Current preview. Eligibility is checked again at approval.</p></div></div>
        {selection !== undefined && <div className="commission-scroll"><Table><thead><tr><th>Include</th><th>Employee / policy</th><th>Receipt / source</th><th>Amount</th></tr></thead><tbody>
          {(changeSelection ? available : selected).map(e => <tr key={payrollRowKey(e)}><td><Input type="checkbox" aria-label={'Include ' + e.producerName + ' ' + e.policyNumber + ' ' + e.receivedOn + ' ' + money(e.amountCents)}
            checked={selection.includes(payrollRowKey(e))} onChange={event => { const checked = event.target.checked; setSelection(keys => checked ? [...(keys ?? []), payrollRowKey(e)] : (keys ?? []).filter(key => key !== payrollRowKey(e))); }} /></td>
            <td>{e.producerName}<div className="small muted">{e.accountName} · {e.policyNumber}</div></td><td>{e.receivedOn}<div className="small muted">{payrollSourceLabel(e)}</div></td><td>{money(e.amountCents)}</td></tr>)}
        </tbody></Table></div>}
        {!available.length && <p>No eligible, unallocated earnings through this cutoff.</p>}
        {stale && <p role="alert" className="error-text">The employee or cutoff selection changed. Choose specific earnings again before saving.</p>}
        {stale && <Button type="button" variant="secondary" onClick={() => setSelection([])}>Clear unavailable selection</Button>}
      </div>}
      {cycle && draftState !== initialState.current && <p role="status" className="commission-notice">Changes are not saved yet. Choose Save off-cycle draft to update payroll readiness.</p>}
      <PayrollScheduleNotice cutoff={dates.cutoff} />
      {!!selection?.length && !stale && latestReceipt && latestReceipt !== dates.cutoff && latestReceipt < dates.reviewOn && <div className="payroll-selection">
        <Button type="button" variant="secondary" onClick={() => setDates(d => ({ ...d, cutoff: latestReceipt }))}>Use selected receipts through {displayDate(latestReceipt)}</Button>
        <p className="small muted">Use the last selected receipt date as the cutoff. The selected earnings and other payroll dates stay as shown; review them before saving.</p>
      </div>}
      <LabeledInput label="Off-cycle reason" value={reason} set={setReason} />
      <div className="form-grid">
        {(
          [
            ["cutoff", "Off-cycle receipt cutoff"],
            ["reviewOn", "Off-cycle review date"],
            ["hrDueOn", "Off-cycle HR report date"],
            ["processingOn", "Off-cycle processing date"],
            ["payDate", "Off-cycle pay date"],
          ] as const
        ).map(([key, label]) => (
          <LabeledInput
            key={key}
            label={label}
            type="date"
            value={dates[key]}
            set={(v) => setDates((d) => ({ ...d, [key]: v }))}
          />
        ))}
      </div>
    </Action>
  );
}
function ReportHistory({ workspace }: { workspace: PayrollWorkspace }) {
  const [confirmed, setConfirmed] = useState(false);
  return (
    <Panel title="Approved report versions">
      <p>
        Original approved PDFs remain unchanged. Historical copies do not
        authorize another payment.
      </p>
      <label className="payroll-check">
        <Input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />{" "}
        I am downloading historical records, not additional payment
        instructions.
      </label>
      {(workspace.reports ?? []).map((r) => (
        <div key={r.id}>
          <p>
            {r.cycleId} · Revision {r.revision} · {money(r.totalCents)} ·
            Approved {new Date(r.createdAt).toLocaleString()} by {r.createdBy}
          </p>
          <Action
            label={`Download ${r.cycleId} revision ${r.revision} files`}
            disabled={!confirmed}
            refresh={async () => {}}
            action={() =>
              downloadReport({
                id: r.cycleId,
                revision: r.revision,
                historicalConfirmed: confirmed,
              })
            }
          />
          <Panel title="Report integrity reference">
            <code>{r.contentHash}</code>
          </Panel>
        </div>
      ))}
      {!workspace.reports?.length && <p>No approved report versions yet.</p>}
    </Panel>
  );
}
function AuditHistory() {
  const invalidate = useContext(PayrollAccessContext),
    [cursor, setCursor] = useState<string | undefined>();
  const resource = useAsyncResource(
    async () => {
      try {
        return await commissionAction<{
          entries: {
            id: string;
            actor: string;
            at: string;
            changes: {
              kind: string;
              id: string;
              previousVersion: number;
              newVersion: number;
              value: unknown;
            }[];
          }[];
          cursor?: string;
          legacy?: boolean;
        }>("payrollAudit", { cursor });
      } catch (error) {
        if (isAuthorizationError(error)) invalidate(error);
        throw error;
      }
    },
    [cursor],
    { clearDataOnError: () => true },
  );
  return (
    <section aria-label="Commission audit history">
      <h3>Audit history</h3>
      {resource.error && <p role="alert">{resource.error}</p>}
      {resource.loading && <p>Loading audit history.</p>}
      {resource.data?.legacy && (
        <p>
          Earlier-format audit records, in stored record order. Original
          timestamps and changes are preserved.
        </p>
      )}
      {resource.data?.entries.map((e) => (
        <Panel
          key={e.id}
          title={new Date(e.at).toLocaleString() + " · " + e.actor}
          hint={e.changes.map((c) => c.kind + " " + c.id).join(", ")}
        >
          {e.changes.map((change, index) => (
            <section className="commission-audit-change" key={change.kind + ":" + change.id + ":" + index}>
              <h4>{change.kind}</h4>
              <p className="small"><strong>Record</strong> <code>{change.id}</code></p>
              <p className="small muted">Version {change.previousVersion} → {change.newVersion}</p>
              <Panel title="Stored record values">
                <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(change.value, null, 2)}</pre>
              </Panel>
            </section>
          ))}
        </Panel>
      ))}
      {resource.data?.cursor && (
        <Button
          variant="secondary"
          onClick={() => setCursor(resource.data?.cursor)}
        >
          Older audit entries
        </Button>
      )}
      {cursor && (
        <Button variant="secondary" onClick={() => setCursor(undefined)}>
          Latest audit entries
        </Button>
      )}
    </section>
  );
}

function EmployeeCalculations({cycle,workspace}:{cycle:PayrollCycle;workspace:PayrollWorkspace}) {
  const {navigate}=useCommissionWorkflow();
  const rows=cycle.status==='OPEN' ? (cycle.preview?.rows ?? []) : workspace.batches.filter(b=>cycle.batchIds.includes(b.id)).flatMap(b=>b.lines.map(l=>({...l,producerId:b.producerId,producerName:b.producerName})));
  return <CommissionPanel title="Employee calculations & source statements">
    {!rows.length && <p>No calculation lines in this cycle. Refresh payroll if this preview predates the current workflow.</p>}
    {[...new Set(rows.map(r=>r.producerId))].map(id=><details key={id}><summary>{rows.find(r=>r.producerId===id)?.producerName} · {money(sum(rows.filter(r=>r.producerId===id).map(r=>r.amountCents)))}</summary>
      {rows.filter(r=>r.producerId===id).map(r=>{
        const source=workspace.sourceLinks?.find(s=>s.policyId===r.policyId&&s.entryId===r.entryId);
        return <div className="commission-work-item" key={payrollRowKey(r)}><div><strong>{r.policyNumber} · {money(r.amountCents)}</strong><p>{r.receivedOn} · agency {money(r.agencyCents)} · {r.shareBps===undefined?'':(r.shareBps/100)+'% share × '}{r.producerBps/100}% saved rate{' · '+payrollSourceLabel(r)}</p></div>
          <Button variant="secondary" onClick={()=>navigate(payrollRevenueKind(r) === 'IPFS_FEE' ? {tab:'ipfs',policyId:r.policyId} : source?{tab:'statements',...(source.intakeId?{intakeId:source.intakeId}:{statementId:source.statementId})}:{tab:'ledger',policyId:r.policyId})}>Open source</Button>
          {cycle.status==='OPEN' && <Button variant="secondary" onClick={()=>navigate({tab:'payroll',earningKeys:[payrollRowKey(r)],producerId:r.producerId})}>Prepare off-cycle payment</Button>}
        </div>;
      })}
    </details>)}
  </CommissionPanel>;
}
