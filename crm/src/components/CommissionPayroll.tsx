import {
  createContext,
  useContext,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { commissionAction } from "../lib/commissions";
import { useAsyncResource } from "../lib/useAsyncResource";
import { useEditProtection, useUnsavedChanges } from "../lib/editProtection";
import { isAuthorizationError } from "../lib/authorizationError";
import {
  batchPaidCents,
  sum,
  decimal,
  type CommissionBatch,
} from "../../../shared/commissions";
import { zipSync } from "fflate";
import "./CommissionPayroll.css";
import CommissionPanel from "./CommissionPanel";
import {
  COMMISSION_START_MONTH,
  payrollDay,
  payrollRowKey,
  suggestPayrollDates,
  type PayrollCycle,
  type PayrollSettings,
  type PayrollWorkspace,
} from "../../../shared/commissionPayroll";

const money = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );
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
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  danger?: boolean;
}) {
  return <CommissionPanel title={title} hint={hint} danger={danger}>{children}</CommissionPanel>;
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
  const [auditOpen, setAuditOpen] = useState(false), [selectedCycle, setSelectedCycle] = useState("");
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
    { clearDataOnError: () => true },
  );
  const refresh = async () => {
    await resource.refetch();
    await refreshLedger();
  };
  const data = resource.data;
  const cycles = data?.workspace.cycles ?? [];
  const focused = cycles.find(c => c.id === selectedCycle) ??
    cycles.filter(c => c.status === "OPEN").sort((a,b) => a.cutoff.localeCompare(b.cutoff))[0] ??
    cycles.find(c => c.status === "APPROVED") ?? cycles[0];
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
            <h2>Monthly payroll & HR delivery</h2>
            <p className="muted">
              Review commissions, approve payroll, and track delivery through
              payment.
            </p>
          </div>
          <button
            className="secondary"
            disabled={resource.loading}
            onClick={() => void resource.refetch()}
          >
            Refresh payroll
          </button>
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
            {owner && !!cycles.length && <label className="field payroll-cycle-picker">
              <span>Review payroll cycle</span>
              <select value={focused?.id ?? ""} onChange={e => requestLeave(() => setSelectedCycle(e.target.value))}>
                {cycles.map(c => <option key={c.id} value={c.id}>{displayMonth(c.id)} · {c.cycleType === "OFF_CYCLE" ? "Off-cycle" : "Monthly"} · {c.status.toLowerCase()}</option>)}
              </select>
              <small className="muted">One cycle at a time. Earlier reports and payment history remain available.</small>
            </label>}
            {owner && <PayrollReadiness workspace={data.workspace} cycle={focused} reviewStatements={reviewStatements} />}
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
                  title="Add an off-cycle payment"
                  hint="Create a supplemental employee run"
                >
                  <OffCycleForm
                    producers={data.workspace.producers ?? []}
                    earnings={data.workspace.availableEarnings ?? []}
                    refresh={refresh}
                  />
                </Panel>
              )}
            </div>
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
              />
            ))}
            <section
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
                  {data.workspace.deliveries.length} deliveries
                </span>
              </div>
              {!data.workspace.deliveries.length && (
                <div className="payroll-empty">No reports have been sent.</div>
              )}
              {data.workspace.deliveries.map((d) => (
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
            </section>
            {owner && <ReportHistory workspace={data.workspace} />}
            {owner && (
              <>
                <button
                  className="secondary"
                  onClick={() => setAuditOpen((v) => !v)}
                >
                  {auditOpen ? "Close audit history" : "View audit history"}
                </button>
                {auditOpen && <AuditHistory />}
              </>
            )}
          </>
        )}
      </section>
    </PayrollAccessContext.Provider>
  );
}
function PayrollReadiness({ workspace, cycle, reviewStatements }: { workspace: PayrollWorkspace; cycle?: PayrollCycle; reviewStatements?: () => void }) {
  const readiness = workspace.statementReadiness;
  if (!cycle || !readiness) return null;
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
      <div><span>{cycle.status === 'OPEN' ? 'Eligible earnings in preview' : 'Approved commission'}</span><strong>{money(cycle.preview?.totalCents ?? cycle.totalCents)}</strong><small>{cycle.preview?.blockers.length ? cycle.preview.blockers.length + ' approval issues to resolve' : cycle.status === 'OPEN' ? 'Ready for Owner review' : 'Revision ' + cycle.revision}</small></div>
      <div><span>HR delivery & payment</span><strong>{delivery}</strong><small>{money(paid)} paid · {money(Math.max(0, cycle.totalCents - paid))} approved balance</small></div>
    </div>
    {!!pending.length && <p className="commission-notice">Finish posting: {pending.slice(0, 3).map(s => s.reference).join('; ')}{pending.length > 3 ? ' and ' + (pending.length - 3) + ' more' : ''}.</p>}
    {reviewStatements && <button className="secondary" onClick={reviewStatements}>Review statement inbox</button>}
    <p className="small muted">Review this selected cycle for eligibility exceptions, approval, report versions, delivery evidence and payment confirmation.</p>
  </section>;
}

function Action({
  label,
  action,
  refresh,
  children,
  disabled = false,
}: {
  label: string;
  action: () => Promise<unknown>;
  refresh: () => Promise<void>;
  children?: ReactNode;
  disabled?: boolean;
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
        <div className="payroll-form-footer">
          <button
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
          </button>
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
function Input({
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
      <input
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
        <Input
          label="HR report email"
          type="email"
          required={draft.enabled}
          value={draft.hrRecipient}
          set={(v) => update({ hrRecipient: v })}
        />
        <Input
          label="Owner review & reminder email"
          type="email"
          required={draft.enabled}
          value={draft.reviewRecipient}
          set={(v) => update({ reviewRecipient: v })}
        />
      </div>
      <label className="payroll-check">
        <input
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
        <button
          type="button"
          className="secondary"
          disabled={!draft.id}
          onClick={suggestDates}
        >
          Use standard Friday cutoff and Monday report
        </button>
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
          <Input
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
}: {
  cycle: PayrollCycle;
  workspace: PayrollWorkspace;
  owner: boolean;
  refresh: () => Promise<void>;
}) {
  const [confirmed, setConfirmed] = useState(false),
    [paidOn, setPaidOn] = useState(payrollDay()),
    [reference, setReference] = useState(""),
    [reason, setReason] = useState(""),
    [hrHeld, setHrHeld] = useState(false);
  const paidCents = sum(
    workspace.batches
      .filter((b) => c.batchIds.includes(b.id))
      .map(batchPaidCents),
  );
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
      {!!c.preview?.blockers.length && (
        <div className="payroll-notice" role="alert">
          <strong>Resolve before approval</strong>
          <ul>
            {c.preview.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </div>
      )}
      {c.status === "OPEN" && c.preview?.entryCount === 0 && (
        <p>
          No payable commissions are currently recorded. Approve a zero report
          only after checking that all carrier receipts have been reconciled.
        </p>
      )}
      <div className="commission-scroll payroll-totals">
        <table aria-label={"Employee totals for " + c.id}>
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
        </table>
      </div>
      <div className="payroll-cycle-actions">
      {owner && c.status === "OPEN" && (
        <>
          <Panel title={c.cycleType === 'OFF_CYCLE' ? 'Edit off-cycle dates and earnings' : 'Edit payroll dates'}>
            {c.cycleType === 'OFF_CYCLE'
              ? <OffCycleForm cycle={c} producers={workspace.producers??[]} earnings={workspace.availableEarnings??[]} refresh={refresh} />
              : <CycleForm cycle={c} refresh={refresh} />}
          </Panel>
          <Action
            label="Approve payroll cycle"
            disabled={!confirmed || !c.preview || !!c.preview.blockers.length}
            refresh={refresh}
            action={() =>
              commissionAction("approvePayrollCycle", {
                id: c.id,
                version: c.version,
                previewToken: c.preview?.token,
                confirmed,
              })
            }
          >
            <label className="payroll-check">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />{" "}
              I reviewed carrier receipts, eligibility, employee totals, prior
              commission payments, and payroll dates.
            </label>
          </Action>
        </>
      )}
      {owner &&
        ["OPEN", "APPROVED"].includes(c.status) &&
        paidCents === 0 &&
        !workspace.deliveries.some(
          (d) =>
            d.cycleId === c.id &&
            d.cycleRevision === c.revision &&
            d.reportType === "PAYROLL",
        ) && (
          <Panel title="Cancel this unpaid cycle" danger>
            <Action
              label="Cancel payroll cycle"
              refresh={refresh}
              action={() =>
                commissionAction("cancelPayrollCycle", {
                  id: c.id,
                  version: c.version,
                  reason,
                })
              }
            >
              <Input
                label="Cancellation reason"
                value={reason}
                set={setReason}
              />
            </Action>
          </Panel>
        )}
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
        <Panel title="Employee pay-file documents">
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
      {c.status === "APPROVED" && (
        <>
          <Panel title="Record individual employee payments">
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
              <Input
                label="Actual payment date"
                type="date"
                value={paidOn}
                set={setPaidOn}
              />
              <Input
                label="Payroll confirmation reference"
                value={reference}
                set={setReference}
              />
              <label className="payroll-check">
                <input
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
        <Panel title="Prepare a replacement cycle">
          <CycleForm cycle={c} refresh={refresh} />
        </Panel>
      )}
      {c.status === "PAID" && (
        <Panel title="Employee payment history">
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
            <Input
              label="Report correction reason"
              value={reason}
              set={setReason}
            />
            <label className="payroll-check">
              <input
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
      <Input
        label={`Amount paid to ${batch.producerName} (USD)`}
        value={amount}
        set={setAmount}
      />
      <Input
        label={`Payment date for ${batch.producerName}`}
        type="date"
        value={paidOn}
        set={setPaidOn}
      />
      <Input
        label={`Payment reference for ${batch.producerName}`}
        value={reference}
        set={setReference}
      />
      <label className="payroll-check">
        <input
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
}: {
  producers: { id: string; name: string }[];
  cycle?: PayrollCycle;
  earnings: NonNullable<PayrollWorkspace['availableEarnings']>;
  refresh: () => Promise<void>;
}) {
  const [dates, setDates] = useState(
      cycle ? { id: cycle.id, cutoff: cycle.cutoff, reviewOn: cycle.reviewOn, hrDueOn: cycle.hrDueOn, processingOn: cycle.processingOn, payDate: cycle.payDate } : suggestPayrollDates(payrollDay().slice(0, 7)),
    ),
    [reason, setReason] = useState(cycle?.reason ?? ""),
    [producerIds, setProducers] = useState<string[]>(cycle?.producerIds ?? []),
    [requestId, setRequestId] = useState(() => crypto.randomUUID().slice(0, 8));
  const [selection, setSelection] = useState<string[] | undefined>(cycle?.selectedEarningKeys);
  const available = earnings.filter(e => producerIds.includes(e.producerId) && e.receivedOn <= dates.cutoff);
  const selected = available.filter(e => !selection || selection.includes(payrollRowKey(e)));
  const stale = !!selection?.some(key => !available.some(e => payrollRowKey(e) === key));
  const draftState=JSON.stringify({ dates, reason, producerIds, selection });
  const initialState=useRef(draftState);
  useUnsavedChanges(draftState !== initialState.current);
  return (
    <Action
      label={cycle ? "Save off-cycle draft" : "Create off-cycle draft"}
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
        if (!cycle) {
          initialState.current = JSON.stringify({ dates, reason: "", producerIds: [], selection: undefined });
          setReason("");
          setProducers([]);
          setSelection(undefined);
          setRequestId(crypto.randomUUID().slice(0, 8));
        }
      }}
    >
      <p>Choose employees, then include all available earnings or select specific receipts and adjustments. Earnings reserved by another approved cycle are excluded.</p>
      <div className="payroll-people">
        {producers.map((p) => (
          <label className="payroll-check payroll-person" key={p.id}>
            <input
              type="checkbox"
              checked={producerIds.includes(p.id)}
              onChange={(e) =>
                setProducers((ids) =>
                  e.target.checked
                    ? [...ids, p.id]
                    : ids.filter((id) => id !== p.id),
                )
              }
            />{" "}
            {p.name}
          </label>
        ))}
      </div>
      {!producers.length && (
        <p>No employees with commission policy records are available yet.</p>
      )}
      <label className="field">Earnings to include
        <select value={selection === undefined ? 'all' : 'selected'} onChange={e => setSelection(e.target.value === 'all' ? undefined : [])}>
          <option value="all">All eligible earnings through the cutoff</option>
          <option value="selected">Choose specific earnings</option>
        </select>
      </label>
      {!!producerIds.length && <div className="payroll-selection">
        <div className="commission-section-heading"><div><strong>{selected.length} earnings · {money(sum(selected.map(e => e.amountCents)))}</strong><p className="small muted">Current preview. Eligibility is checked again at approval.</p></div></div>
        {selection !== undefined && <div className="commission-scroll"><table><thead><tr><th>Include</th><th>Employee / policy</th><th>Receipt / source</th><th>Amount</th></tr></thead><tbody>
          {available.map(e => <tr key={payrollRowKey(e)}><td><input type="checkbox" aria-label={'Include ' + e.producerName + ' ' + e.policyNumber + ' ' + e.receivedOn + ' ' + money(e.amountCents)}
            checked={selection.includes(payrollRowKey(e))} onChange={event => setSelection(keys => event.target.checked ? [...(keys ?? []), payrollRowKey(e)] : (keys ?? []).filter(key => key !== payrollRowKey(e)))} /></td>
            <td>{e.producerName}<div className="small muted">{e.accountName} · {e.policyNumber}</div></td><td>{e.receivedOn}<div className="small muted">{e.source === 'ADJUSTMENT' ? 'Approved adjustment' : e.source === 'SHARED_RECEIPT' ? 'Shared receipt' : 'Commission receipt'}</div></td><td>{money(e.amountCents)}</td></tr>)}
        </tbody></table></div>}
        {!available.length && <p>No eligible, unallocated earnings through this cutoff.</p>}
        {stale && <p role="alert" className="error-text">The employee or cutoff selection changed. Choose specific earnings again before saving.</p>}
        {stale && <button type="button" className="secondary" onClick={() => setSelection([])}>Clear unavailable selection</button>}
      </div>}
      <Input label="Off-cycle reason" value={reason} set={setReason} />
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
          <Input
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
        <input
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
        <button
          className="secondary"
          onClick={() => setCursor(resource.data?.cursor)}
        >
          Older audit entries
        </button>
      )}
      {cursor && (
        <button className="secondary" onClick={() => setCursor(undefined)}>
          Latest audit entries
        </button>
      )}
    </section>
  );
}
