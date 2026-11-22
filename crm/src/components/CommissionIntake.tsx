import { formatUsdCents as money } from "../../../shared/money";
import type { CommissionOperationName } from '../../../shared/apiOperations';
import { useEffect,useRef,useState,type ChangeEvent,type FormEvent,type InputHTMLAttributes,type ReactNode } from "react";
import {
emptyImportMapping,
importedMoney,
parseStatementCsv,
} from "../../../shared/commissionImport";
import {
exactPolicyMatches,
prepareIntakeRows,
reservedCents,
rowIssues,
type CarrierImportTemplate,
type IntakeRow,
type IntakeSettlement,
type IntakeWorkspace,
type StatementIntake,
} from "../../../shared/commissionIntake";
import { isCarrierReceipt, sum,type CommissionOverview } from "../../../shared/commissions";
import { isAuthorizationError } from "../../../shared/authorizationError";
import { useEditProtection,useCommissionUnsavedChanges as useUnsavedChanges } from "../lib/commissionEditProtection";
import { commissionWorkflowAction as commissionAction } from "../lib/commissions";
import { displayCommissionAmount,importColumnLabels,suggestImportMapping,suggestImportTable } from '../lib/commissionSourceGuidance';
import { attachCommissionStatement } from "../lib/commissionStatementAttachment";
import { readCommissionWorkbook } from "../lib/commissionWorkbook";
import { CommissionBadge,useCommissionPreference,useCommissionWorkflow } from '../lib/commissionWorkflow';
import { useAsyncResource } from "../lib/useAsyncResource";
import CommissionDeposits from "./CommissionDeposits";
import CommissionDraftRecovery from "./CommissionDraftRecovery";
import "./CommissionIntake.css";
import CommissionJourney,{ commissionSteps } from "./CommissionJourney";
import CommissionPanel from "./CommissionPanel";
import CommissionSourcePreview from './CommissionSourcePreview';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Select } from './ui/Select';
import { Table } from './ui/Table';
import { Textarea } from './ui/Textarea';


const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
type Detail = {
  intake: StatementIntake;
  rows: IntakeRow[];
  settlements: IntakeSettlement[];
};
type PolicySetup = (
  policyNumber: string,
  carrierId: string,
  adopted: (id: string) => void,
) => ReactNode;
function useTask(onError?: (error: unknown) => void) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const lock = useRef(false);
  const run = async (work: () => Promise<void>) => {
    if (lock.current) return false;
    lock.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Statement action failed.");
      onError?.(e);
      return false;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return { busy, error, message, setMessage, run };
}
function Feedback({ task }: { task: ReturnType<typeof useTask> }) {
  const {navigate}=useCommissionWorkflow();
  return (
    <>
      {task.error && (
        <p className="error-text" role="alert">
          {task.error}
          {/GIM|assignment|agreement|plan rate/i.test(task.error) && <Button variant="secondary" onClick={()=>navigate({tab:"settings"})}>Review employee assignment</Button>}
        </p>
      )}
      {task.message && (
        <p className="commission-notice" role="status">
          {task.message}
        </p>
      )}
    </>
  );
}
function CurrencyInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const [focused, setFocused] = useState(false);
  return <Input {...props} type="text" inputMode="decimal"
    value={!focused ? displayCommissionAmount(String(props.value ?? "")) : props.value}
    onFocus={e => { setFocused(true); props.onFocus?.(e); }}
    onBlur={e => { setFocused(false); props.onBlur?.(e); }} />;
}
function Field({ label, value, set, type = "text", required = false, currency = false }: {
  label: string; value: string; set: (v: string) => void; type?: string; required?: boolean; currency?: boolean;
}) {
  const props = { value, required, onChange: (e: ChangeEvent<HTMLInputElement>) => set(e.target.value) };
  return <label className="field"><span>{label}</span>
    {currency ? <CurrencyInput {...props} /> : <Input {...props} type={type} />}
  </label>;
}
const phase = (s: StatementIntake, settlements: IntakeSettlement[]) =>
  s.status === "VOID"
    ? "Voided"
    : settlements.some(x => x.intakeId === s.id && ["RECORDED", "POSTING"].includes(x.status))
      ? "Settlement needs review"
      : s.rowCount > 0 && s.completedRows === s.rowCount
        ? "Posted"
        : s.needsReview ||
            !s.rowCount ||
            s.totalCents === undefined ||
            s.totalCents !== s.rowTotalCents
          ? "Needs matching / review"
          : "Awaiting payment";

const priority = (s: StatementIntake, settlements: IntakeSettlement[]) => {
  const label = phase(s, settlements);
  return label === "Settlement needs review" ? 0 : label === "Needs matching / review" ? 1 : label === "Awaiting payment" ? 2 : 3;
};

function statementStep(intake: StatementIntake, settlements: IntakeSettlement[]) {
  if (phase(intake, settlements) === "Posted") return 4;
  if (!intake.rowCount) return 0;
  if (intake.needsReview || intake.unmatched || intake.totalCents === undefined || intake.totalCents !== intake.rowTotalCents) return 1;
  return settlements.some(s => s.status === "RECORDED" || s.status === "POSTING") ? 3 : 2;
}

function StatementSummary({ detail, data, choose }: { detail: Detail; data: CommissionOverview; choose: (step: number) => void }) {
  const { intake, settlements } = detail;
  const { navigate, target } = useCommissionWorkflow();
  const postedStatements = new Set(settlements.flatMap(s=>s.statementIds));
  const entries = data.policies.flatMap(p=>p.entries.filter(e=>postedStatements.has(e.statementId)));
  const entryIds = new Set(entries.map(e=>e.id));
  const shared = (data.earnings ?? []).filter(e=>e.source==='SHARED_RECEIPT' && entryIds.has(e.entryId) && e.status==='PAYABLE');
  const earned = sum([...entries.filter(e=>e.kind==='RECEIPT'&&!e.allocationId).map(e=>e.producerCents), ...shared.map(e=>e.amountCents)]);
  const recorded = sum(settlements.filter(s=>s.status!=='VOID').map(s=>s.totalCents));
  const allocated = sum(settlements.filter(s=>s.status!=='VOID').flatMap(s=>s.allocations.map(a=>a.amountCents)));
  const complete = phase(intake,settlements)==='Posted';
  const preparation = !intake.rowCount ? 'Ready to import' : intake.needsReview || intake.unmatched || intake.totalCents===undefined || intake.totalCents!==intake.rowTotalCents ? 'Review needed' : 'Matches complete';
  const payment = !settlements.some(s=>s.status!=='VOID') ? 'Awaiting payment' : settlements.some(s=>['RECORDED','POSTING'].includes(s.status)) ? 'Received · posting needed' : complete ? 'Fully posted' : 'Partially paid';
  const next = !intake.rowCount ? 'Review source columns' : preparation==='Review needed' ? 'Review unresolved rows' : settlements.some(s=>['RECORDED','POSTING'].includes(s.status)) ? 'Review and post payment' : complete ? 'Continue to payroll' : 'Confirm carrier payment';
  const move = () => {
    if (complete) { navigate({tab:'payroll',intakeId:intake.id,intakeReference:intake.reference,...(target.cycleId ? {cycleId:target.cycleId} : {})}); return; }
    choose(statementStep(intake, settlements));
  };
  return <section className="intake-summary" aria-label="Statement totals and next action">
    <div className="commission-action-bar"><CommissionBadge>{preparation}</CommissionBadge><CommissionBadge tone={complete?'green':'amber'}>{payment}</CommissionBadge><Button variant="primary" onClick={move}>{next}</Button></div>
    <p className="intake-next-action">{!intake.rowCount ? "Your file is saved. Next, check the suggested columns and source preview, then confirm and import the rows for review." : preparation === "Review needed" ? "Next, check each policy match and eligibility, then save the reviewed rows. Employee earnings are calculated only after payment is confirmed and posted." : complete ? "This statement is posted. Continue to payroll to review employee earnings." : settlements.some(s => ["RECORDED", "POSTING"].includes(s.status)) ? "Next, review the recorded payment and its allocation, then confirm posting. Resume any interrupted posting before payroll." : "Next, record the carrier payment received, then review its allocation before posting earnings."}</p>
    <div className="intake-totals"><span>Source <strong>{intake.totalCents===undefined?'Not entered':money(intake.totalCents)}</strong></span><span>Recorded receipts <strong>{money(recorded)}</strong></span><span>Allocated <strong>{money(allocated)}</strong></span><span>Posted agency receipts <strong>{money(intake.postedCents)}</strong></span><span>Employee earnings <strong>{money(earned)}</strong></span><span>Source remaining <strong>{intake.totalCents===undefined?'Not entered':money(intake.totalCents-intake.postedCents)}</strong></span></div>
    {!!entries.length && <p className="small">Posted earnings: {entries.some(e=>e.batchId)||shared.some(e=>e.batchId)?'Some or all are included in payroll; inspect the selected cycle for approval and payment status.':'Awaiting payroll review.'}</p>}
  </section>;
}

export default function CommissionIntake({
  data,
  refreshLedger,
  renderPolicySetup,
  onAccessDenied,
}: {
  data: CommissionOverview;
  refreshLedger: () => Promise<void>;
  renderPolicySetup: PolicySetup;
  onAccessDenied: (error: unknown) => void;
}) {
  const [filter, setFilter] = useCommissionPreference('statement-filter', 'active');
  const [historyPages, setHistoryPages] = useState<(string | undefined)[]>([undefined]);
  const historyCursor = historyPages.at(-1);
  const resource = useAsyncResource(
    async () => {
      try { return await commissionAction<IntakeWorkspace>("intakeWorkspace", {history:filter!=='active',cursor:historyCursor}); }
      catch (error) { if (isAuthorizationError(error)) onAccessDenied(error); throw error; }
    },
    [filter, historyCursor],
    { clearDataOnError: () => true, live: { topics: ['OWNER'], protectEdits: true } },
  );
  const { requestLeave } = useEditProtection();
  const { target, remember } = useCommissionWorkflow();
  const [selected, saveSelected] = useCommissionPreference('selected-statement', '');
  const setSelected = (id:string) => { saveSelected(id); remember?.({intakeId:id,depositId:undefined,statementId:undefined,cycleId:undefined,intakeStep:undefined,intakeReference:undefined}); };
  const [adding, setAdding] = useState(false);
  useEffect(() => { if (target.depositId) {saveSelected("");setAdding(false);} },[target.depositId]);
  const [query, setQuery] = useCommissionPreference('statement-search', '');
  useEffect(() => { if (target.intakeId) { saveSelected(target.intakeId); setAdding(false); } }, [target.intakeId]);
  const denied = (error: unknown) => {
    if (isAuthorizationError(error)) {
      resource.invalidate(error);
      onAccessDenied(error);
    }
  };
  const refresh = async () => {
    await resource.refetch();
    await refreshLedger();
  };
  const workspace = resource.data;
  if (!workspace)
    return (
      <div className="card">
        <p role={resource.error ? "alert" : undefined}>
          {resource.error || "Loading statement inbox…"}
        </p>
        {resource.error && (
          <Button variant="secondary" onClick={() => void resource.refetch()}>
            Retry statement inbox
          </Button>
        )}
      </div>
    );
  if (selected) return <section className="commission-intake" aria-label="Carrier statement inbox"><IntakeDetail
          key={selected}
          id={selected}
          data={data}
          templates={workspace.templates}
          refresh={refresh}
          renderPolicySetup={renderPolicySetup}
          onError={denied}
          close={() => requestLeave(() => setSelected(""))}
        /></section>;
  const queue = [...workspace.intakes].sort((a, b) => priority(a, workspace.settlements) - priority(b, workspace.settlements) || a.documentReceivedOn.localeCompare(b.documentReceivedOn) || a.reference.localeCompare(b.reference));
  const items = queue.filter(
    (s) =>
      (filter === "all" ||
        (filter === "active"
          ? !["Posted", "Voided"].includes(phase(s, workspace.settlements))
          : phase(s, workspace.settlements) === filter)) &&
      (s.reference + " " + s.carrierName + " " + s.filename)
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <section className="commission-intake" aria-label="Carrier statement inbox">
      <div className="commission-section-heading">
        <div>
          <h2>Statement inbox</h2>
          <p>
            Log statements as they arrive. Match policies now; confirm payment
            when it occurs.
          </p>
        </div>
        <Button
          variant="primary"
          onClick={() =>
            requestLeave(() => {
              setAdding(true);
              setSelected("");
            })
          }
        >
          Log carrier statement
        </Button>
      </div>
      <CommissionDeposits workspace={workspace} carriers={data.carriers} refresh={refresh} onError={denied} openStatement={setSelected}/>
      <section className="intake-work-queue" aria-label="Prioritized commission work">
        <h3>Next work</h3>
        <p className="small muted">Received settlements first, then statement review, then statements awaiting payment. Oldest arrivals come first within each group.</p>
        {queue.filter(s => priority(s, workspace.settlements) < 3).slice(0, 5).map(s =>
          <div className="intake-queue-item" key={s.id}>
            <div><strong>{s.reference}</strong><span className="small muted">{s.carrierName} · {phase(s, workspace.settlements)}</span></div>
            <Button variant="secondary" onClick={() => requestLeave(() => { setSelected(s.id); setAdding(false); })}>
              {priority(s, workspace.settlements) === 0 ? "Review settlement" : priority(s, workspace.settlements) === 1 ? "Review statement" : "Review payment"}
            </Button>
          </div>)}
        {!queue.some(s => priority(s, workspace.settlements) < 3) && <p>No unfinished statements.</p>}
      </section>
      <div className="intake-stats">
        <div>
          <strong>
            {
              workspace.intakes.filter(
                (s) =>
                  s.status === "OPEN" &&
                  (!s.rowCount ||
                    s.needsReview > 0 ||
                    s.totalCents === undefined ||
                    s.totalCents !== s.rowTotalCents),
              ).length
            }
          </strong>
          <span>Statements to review</span>
        </div>
        <div>
          <strong>
            {
              workspace.intakes.filter(
                (s) => phase(s, workspace.settlements) === "Awaiting payment",
              ).length
            }
          </strong>
          <span>Awaiting payment</span>
        </div>
        <div>
          <strong>
            {
              workspace.settlements.filter((s) =>
                ["RECORDED", "POSTING"].includes(s.status),
              ).length
            }
          </strong>
          <span>Settlements to post</span>
        </div>
      </div>
      {adding && (
        <NewIntake
          carriers={data.carriers}
          onError={denied}
          saved={async (id) => {
            await refresh();
            setAdding(false);
            setSelected(id);
          }}
          cancel={() => requestLeave(() => setAdding(false))}
        />
      )}
      <div className="intake-filters">
        <Field label="Find a statement" value={query} set={setQuery} />
        <label className="field">
          Show
          <Select value={filter} onChange={(e) => {const value=e.target.value;requestLeave(()=>{setFilter(value);setHistoryPages([undefined]);});}}>
            <option value="active">Active work</option>
            <option value="all">All statements</option>
            {[
              "Needs matching / review",
              "Awaiting payment",
              "Settlement needs review",
              "Posted",
              "Voided",
            ].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
        </label>
        <Button
          variant="secondary"
          onClick={() => requestLeave(() => void refresh())}
        >
          Refresh inbox
        </Button>
      </div>
      {filter !== 'active' && <div className="intake-actions"><p>History page {historyPages.length}. Search and status filters apply to this page and active work.</p><Button variant="secondary" disabled={historyPages.length===1} onClick={()=>requestLeave(()=>setHistoryPages(p=>p.slice(0,-1)))}>Previous history page</Button><Button variant="secondary" disabled={!workspace.historyCursor} onClick={()=>requestLeave(()=>setHistoryPages(p=>[...p,workspace.historyCursor]))}>Next history page</Button></div>}
      <div className="commission-scroll">
        <Table>
          <thead>
            <tr>
              <th>Statement / carrier</th>
              <th>Received</th>
              <th>Source rows</th>
              <th>Agency commission</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.id}>
                <td>
                  <strong>{s.reference}</strong>
                  <div className="small muted">{s.carrierName}</div>
                </td>
                <td>{s.documentReceivedOn}</td>
                <td>
                  {s.rowCount} rows
                  <div className="small muted">
                    {s.unmatched} unmatched · {s.needsReview} need review
                  </div>
                </td>
                <td>
                  {s.totalCents === undefined
                    ? "Total not entered"
                    : money(s.totalCents)}
                  <div className="small muted">
                    {money(s.postedCents)} posted
                  </div>
                </td>
                <td>
                  <span className="intake-status">
                    {phase(s, workspace.settlements)}
                  </span>
                </td>
                <td>
                  <Button
                    variant="secondary"
                    onClick={() =>
                      requestLeave(() => {
                        setSelected(s.id);
                        setAdding(false);
                      })
                    }
                  >
                    Open
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
        {!items.length && (
          <p className="commission-compact-empty">
            No statements in this view.
          </p>
        )}
      </div>

    </section>
  );
}
function NewIntake({
  carriers,
  saved,
  cancel,
  onError,
}: {
  carriers: CommissionOverview["carriers"];
  saved: (id: string) => Promise<void>;
  cancel: () => void;
  onError: (e: unknown) => void;
}) {
  const [id] = useState(() => crypto.randomUUID()),
    [carrierId, setCarrier] = useState(""),
    [reference, setReference] = useState(""),
    [date, setDate] = useState(today()),
    [file, setFile] = useState<File | null>(null);
  const source = useRef("");
  const task = useTask(onError);
  const { markClean } = useUnsavedChanges(
    !!file || !!reference || !!carrierId,
    { busy: task.busy },
  );
  return (
    <form
      className="card intake-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void task.run(async () => {
          if (!file) throw new Error("Choose the original carrier statement.");
          if (file.size > 10_000_000)
            throw new Error("Use a source file up to 10 MB.");
          if (!source.current)
            source.current = (await attachCommissionStatement(file)).key;
          await commissionAction("saveStatementIntake", {
            id,
            version: 0,
            carrierId,
            reference,
            documentReceivedOn: date,
            source: source.current,
            filename: file.name,
          });
          markClean();
          await saved(id);
        });
      }}
    >
      <h3>Log a received statement</h3>
      <fieldset disabled={task.busy}>
        <div className="form-grid">
          <label className="field">
            Carrier
            <Select
              required
              value={carrierId}
              onChange={(e) => setCarrier(e.target.value)}
            >
              <option value="">Choose carrier</option>
              {carriers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </label>
          <Field
            label="Statement reference"
            required
            value={reference}
            set={setReference}
          />
          <Field
            label="Statement received on"
            required
            type="date"
            value={date}
            set={setDate}
          />
          <label className="field">
            Original file
            <Input
              required
              type="file"
              accept=".pdf,.csv,.xlsx,.png,.jpg,.jpeg"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  setFile(f);
                  source.current = "";
                  if (!reference) setReference(f.name.replace(/\.[^.]+$/, ""));
                }
              }}
            />
          </label>
        </div>
        <p className="small muted">
          You can save now without matching policies or entering payment
          details.
        </p>
        <div className="intake-actions">
          <Button variant="primary">
            {task.busy ? "Saving…" : "Save to inbox"}
          </Button>
          <Button type="button" variant="secondary" onClick={cancel}>
            Cancel
          </Button>
        </div>
      </fieldset>
      <Feedback task={task} />
    </form>
  );
}
function IntakeDetail({
  id,
  data,
  templates,
  refresh,
  renderPolicySetup,
  onError,
  close,
}: {
  id: string;
  data: CommissionOverview;
  templates: CarrierImportTemplate[];
  refresh: () => Promise<void>;
  renderPolicySetup: PolicySetup;
  onError: (e: unknown) => void;
  close: () => void;
}) {
  const resource = useAsyncResource(
    async () => {
      try { return await commissionAction<Detail>("getStatementIntake", { id }); }
      catch (error) { if (isAuthorizationError(error)) onError(error); throw error; }
    },
    [id],
    { clearDataOnError: () => true, live: { topics: ['OWNER'], protectEdits: true } },
  );
  const task = useTask(onError),
    detail = resource.data;
  const { target, navigate } = useCommissionWorkflow();
  const [chosenStep, setChosenStep] = useState<number | null>(target.intakeStep ?? null);
  const [visited, setVisited] = useState<number[]>([]);
  const [anotherReceipt, setAnotherReceipt] = useState(false);
  const [focusStep, setFocusStep] = useState(false);
  const nextStep = detail ? statementStep(detail.intake, detail.settlements) : 0;
  const activeStep = chosenStep === null ? nextStep : chosenStep;
  const chooseStep = (step: number) => {
    if (step === 4 && detail && nextStep === 4) { navigate({tab:"payroll",intakeId:id,intakeReference:detail.intake.reference,...(target.cycleId ? {cycleId:target.cycleId} : {})}); return; }
    setChosenStep(step); setFocusStep(true);
  };
  useEffect(() => { if (detail) setVisited(old => old.includes(activeStep) ? old : [...old, activeStep]); }, [activeStep, !!detail]);
  const shown = (step: number) => activeStep === step || visited.includes(step);
  const previousStep = useRef<number | null>(null);
  useEffect(() => {
    if (!detail) return;
    if (previousStep.current !== null && previousStep.current !== nextStep) {
      setChosenStep(null); setFocusStep(true);
    }
    previousStep.current = nextStep;
  }, [nextStep, !!detail]);
  useEffect(() => {
    if (!focusStep || !detail) return;
    const section = document.getElementById(activeStep === 0 ? "intake-import" : activeStep === 1 ? "intake-rows" : activeStep === 4 ? "intake-complete" : "intake-payment");
    section?.scrollIntoView?.({ block: "start" });
    section?.querySelector<HTMLElement>("h3")?.focus({ preventScroll: true });
    setFocusStep(false);
  }, [focusStep, activeStep, detail]);
  const reload = async () => {
    await resource.refetch();
    await refresh();
  };
  const saveRows = async (rows: IntakeRow[], confirmed: boolean) => {
    const current = await commissionAction<Detail>("getStatementIntake", {
      id,
    });
    // Never silently overwrite a teammate's row edits; use the versions reviewed on screen.
    let version = current.intake.version;
    for (let offset = 0; offset < rows.length; offset += 20) {
      try {
        await commissionAction("saveIntakeRows", {
          id,
          version,
          rows: rows.slice(offset, offset + 20),
          confirmed,
          extractionReviewed: confirmed,
        });
      } catch (error) {
        if (offset)
          throw new Error(
            offset +
              " rows were saved before this request stopped. Reopen the statement to review saved rows before continuing. " +
              (error instanceof Error ? error.message : ""),
          );
        throw error;
      }
      version++;
    }
    await reload();
    setChosenStep(null); setFocusStep(true);
  };
  if (!detail)
    return (
      <div className="card">
        <p role={resource.error ? "alert" : undefined}>
          {resource.error || "Opening statement…"}
        </p>
        <Button variant="secondary" onClick={() => void resource.refetch()}>
          Retry
        </Button>
      </div>
    );
  const { intake, rows, settlements } = detail;
  return (
    <div className="intake-detail">
      <div className="commission-section-heading">
        <div>
          <h2>{intake.reference}</h2>
          <p>
            {intake.carrierName} · received {intake.documentReceivedOn} ·{" "}
            {intake.filename}
          </p>
        </div>
        <div className="intake-actions">
          <Button
            variant="secondary"
            onClick={() =>
              void task.run(async () => {
                const r = await commissionAction<{ url: string }>("file", {
                  key: intake.source,
                });
                window.open(r.url, "_blank", "noopener,noreferrer");
              })
            }
          >
            Original statement
          </Button>
          <Button variant="secondary" disabled={task.busy} onClick={() => void task.run(reload)}>Refresh statement</Button>
          <Button variant="secondary" onClick={close}>
            Close statement
          </Button>
        </div>
      </div>
      <Feedback task={task} />
      {intake.status === "VOID" ? (
        <p className="commission-notice">Voided: {intake.voidReason}</p>
      ) : (
        <>
          <CommissionJourney nextStep={nextStep} activeStep={activeStep} choose={chooseStep} />
          <StatementSummary detail={detail} data={data} choose={chooseStep} />
          {nextStep < 2 && settlements.some(s => s.status === "RECORDED" || s.status === "POSTING") && <p role="status" className="commission-notice">Payment recorded. Complete the source review before allocating or posting this settlement.</p>}
          {nextStep >= 2 && <div className="intake-completion-note" role="status"><strong>Source review complete</strong><span>{intake.rowCount} rows saved · {money(intake.rowTotalCents)} reconciled. {nextStep === 2 ? "Next: confirm the carrier payment below." : nextStep === 3 ? "Payment recorded. Review and post the settlement below." : "Settlement posted."}</span></div>}
          {activeStep !== nextStep && <div className="intake-completion-note"><span>{activeStep === 1 && nextStep === 0 ? "Enter source rows below. Each row still needs your review before posting." : activeStep > nextStep ? "Record received money now; source review is still required before posting." : "You are viewing an earlier step. Its saved work is complete."}</span><Button variant="secondary" onClick={() => chooseStep(nextStep)}>Return to {commissionSteps[nextStep].toLowerCase()}</Button></div>}
          <CommissionPanel title="Statement details & control total" hint={intake.totalCents === undefined ? "Enter the statement total" : money(intake.totalCents) + " saved"} open={intake.totalCents===undefined || (!!rows.length && intake.totalCents!==intake.rowTotalCents)} >
          <HeaderEditor
            key={
              "header-" + intake.totalCents + ":" + (intake.statementDate ?? "")
            }
            intake={intake}
            refresh={reload}
            onError={onError}
          />
          </CommissionPanel>
          <div className={activeStep < 2 ? "intake-review-layout" : "intake-current-work"}>
          <div className="intake-review-main">
          {shown(0) && <div id="intake-import" hidden={activeStep !== 0}>
          <h3 tabIndex={-1}>Import source</h3>
          <CommissionPanel
            title="Import statement rows"
            open={!rows.length}
            hint="Check columns, compare the preview, then import for review"
          >
            <IntakeImport
              intake={intake}
              rows={rows}
              data={data}
              template={templates.find((t) => t.carrierId === intake.carrierId)}
              refresh={reload}
              saveRows={saveRows}
              onError={onError}
            />
          </CommissionPanel>
          <div className="intake-source-options"><p>Cannot read this file automatically? Enter its rows, then confirm policy matches and eligibility.</p><Button variant="secondary" onClick={() => chooseStep(1)}>Enter source rows manually</Button></div>
          </div>}{shown(1) && <div hidden={activeStep !== 1}><RowsEditor
            key={"rows-" + rows.map((r) => r.id + ":" + r.version).join(",")}
            detail={detail}
            data={data}
            saveRows={saveRows}
            onContinue={() => chooseStep(nextStep)}
            renderPolicySetup={renderPolicySetup}
            onError={onError}
          />
          </div>}
          {(shown(2) || shown(3)) && <section className="card" id="intake-payment" hidden={activeStep < 2 || activeStep === 4}>
            <div className="commission-section-heading">
              <div>
                <h3 tabIndex={-1}>{activeStep === 3 ? "Review & post settlement" : "Confirm carrier payment"}</h3>
                <p>
                  Record actual agency commission received or retained. The
                  statement received date does not establish payment.
                </p>
              </div>
            </div>
            {shown(2) && <div hidden={activeStep !== 2}>
              {!!settlements.length && <div className="intake-completion-note"><strong>Saved carrier receipts</strong>{settlements.filter(s => s.status !== "VOID").map(s => <p key={s.id}>{s.reference} · {s.receivedOn} · {money(s.totalCents)} · {s.status.toLowerCase()}</p>)}</div>}
              {(nextStep < 4 || anotherReceipt) ? <>
              <p className="intake-step-help">Enter the payment reference, actual receipt date, amount and evidence. Then confirm to continue to the posting review. If payment has not arrived, leave this step for later; your source review is saved.</p>
              <SettlementForm key={settlements.map(s => s.id + ":" + s.version).join(",")} intake={intake} settlements={settlements} refresh={async () => { await reload(); setChosenStep(null); setFocusStep(true); }} onError={onError} />
              </> : <><p>Carrier payment is complete. Continue to payroll to review the posted earnings.</p><Button type="button" variant="secondary" onClick={() => setAnotherReceipt(true)}>Record another receipt</Button></>}
            </div>}
            {shown(3) && <div hidden={activeStep !== 3}>
            {settlements.map((s) => (
              <SettlementCard
                key={s.id + ":" + s.version}
                settlement={s}
                detail={detail}
                data={data}
                refresh={reload}
                onError={onError}
              />
            ))}
            </div>}
            {!settlements.length && (
              <p className="small muted">
                No payment recorded. This statement does not create earnings or
                block payroll while awaiting payment.
              </p>
            )}
          </section>}
          <section id="intake-complete" className="card" hidden={activeStep !== 4}>
            <h3 tabIndex={-1}>Earnings ready for payroll review</h3><p>The statement and carrier payment steps are complete. Continue to payroll above to carry these earnings into the next step.</p>
            {settlements.map(s => <p key={s.id}>{s.reference} · {money(s.totalCents)} · {s.status}</p>)}
          </section>
          </div>
          {activeStep < 2 && <CommissionSourcePreview intake={intake} onError={onError} />}
          </div>
          {nextStep < 2 && activeStep < 2 && <details className="intake-source-options"><summary>Carrier payment already received?</summary><p>You can record the receipt now. Matching and eligibility review must still finish before allocation and posting.</p><Button type="button" variant="secondary" onClick={() => chooseStep(2)}>Record received payment</Button></details>}
          <CommissionPanel title="Payment history" hint={settlements.length ? `${settlements.length} recorded settlements` : "No payments recorded"}>
            {settlements.map(s => <p key={s.id}>{s.reference} · {s.receivedOn} · {money(s.totalCents)} · {s.status}</p>)}
          </CommissionPanel>
          <CommissionPanel
            title="Void this intake"
            danger
            hint="Retain the original document and audit trail"
          >
            <VoidForm
              label="Void statement intake"
              action="voidStatementIntake"
              input={{ id, version: intake.version }}
              refresh={reload}
              onError={onError}
            />
          </CommissionPanel>
        </>
      )}
    </div>
  );
}
function HeaderEditor({
  intake,
  refresh,
  onError,
}: {
  intake: StatementIntake;
  refresh: () => Promise<void>;
  onError: (e: unknown) => void;
}) {
  const [total, setTotal] = useState(
      intake.totalCents === undefined
        ? ""
        : (intake.totalCents / 100).toFixed(2),
    ),
    [date, setDate] = useState(intake.statementDate ?? "");
  const task = useTask(onError),
    initial = useRef(JSON.stringify([total, date]));
  const { markClean } = useUnsavedChanges(
    JSON.stringify([total, date]) !== initial.current,
    { busy: task.busy },
  );
  const difference =
    total === ""
      ? undefined
      : (() => {
          try {
            return importedMoney(total) - intake.rowTotalCents;
          } catch {
            return undefined;
          }
        })();
  return (
    <form
      className="card intake-control"
      onSubmit={(e) => {
        e.preventDefault();
        void task.run(async () => {
          await commissionAction("saveStatementIntake", {
            ...intake,
            totalCents: total === "" ? null : importedMoney(total),
            statementDate: date,
          });
          markClean();
          await refresh();
        });
      }}
    >
      <fieldset disabled={task.busy}>
        <div className="form-grid">
          <Field
            label="Statement agency commission total ($)"
            currency
            value={total}
            set={setTotal}
          />
          <Field
            label="Statement date (optional)"
            type="date"
            value={date}
            set={setDate}
          />
          <div className="field">
            <span>Imported / entered rows</span>
            <strong>{money(intake.rowTotalCents)}</strong>
            <span className={intake.rowCount && difference ? "error-text small" : "small muted"}>
              {!intake.rowCount ? "Import the source rows to compare them with this total." : difference === undefined
                ? "Enter the source total before posting."
                : difference
                  ? money(difference) + " difference to resolve"
                  : "Statement total reconciles"}
            </span>
          </div>
        </div>
        <Button variant="secondary">Save statement details</Button>
      </fieldset>
      <CommissionDraftRecovery compact intake={intake} scope="header" value={{ total, date }}
        restore={d => { setTotal(d.total); setDate(d.date); }} disabled={task.busy} onError={onError}
        renderSaved={d => <dl className="intake-saved-values"><div><dt>Date</dt><dd>{d.date || "Not entered"}</dd></div><div><dt>Total</dt><dd>{displayCommissionAmount(d.total) || "Not entered"}</dd></div></dl>} />
      <Feedback task={task} />
    </form>
  );
}
type SourceTable = { name: string; rows: string[][]; confidence?: number };
function IntakeImport({
  intake,
  rows,
  data,
  template,
  refresh,
  saveRows,
  onError,
}: {
  intake: StatementIntake;
  rows: IntakeRow[];
  data: CommissionOverview;
  template?: CarrierImportTemplate;
  refresh: () => Promise<void>;
  saveRows: (rows: IntakeRow[], reviewed: boolean) => Promise<void>;
  onError: (e: unknown) => void;
}) {
  const [tables, setTables] = useState<SourceTable[]>([]),
    [sheet, setSheet] = useState(0),
    [header, setHeader] = useState(0),
    [mapping, setMapping] = useState(emptyImportMapping),
    [reviewed, setReviewed] = useState(false),
    [text, setText] = useState(""),
    [processing, setProcessing] = useState(false),
    [pollCount, setPollCount] = useState(0);
  const alive = useRef(true);
  const task = useTask(onError),
    table = tables[sheet]?.rows.slice(header);
  let preview: IntakeRow[] = [],
    issue = "";
  if (table)
    try {
      preview = prepareIntakeRows(
        table,
        mapping,
        intake.id,
        sheet * 10000 + header,
        data.policies,
        intake.carrierId,
      ).map((r) => ({
        ...r,
        version: rows.find((old) => old.id === r.id)?.version ?? 0,
      }));
    } catch (e) {
      issue = (e as Error).message;
    }
  const choose = (next: SourceTable[], requestedSheet?: number, requestedHeader?: number) => {
    if (!alive.current) return;
    const suggested = suggestImportTable(requestedSheet === undefined ? next : [next[requestedSheet]], template);
    const index = requestedSheet ?? suggested?.sheet ?? 0;
    const head = requestedHeader ?? suggested?.header ?? 0;
    setTables(next);
    setSheet(index);
    setHeader(head);
    setMapping(suggestImportMapping(next[index]?.rows[head] ?? [], template));
    setReviewed(false);
  };
  useUnsavedChanges(reviewed, { busy: task.busy });
  const read = async () => {
    if (/\.(csv|xlsx)$/i.test(intake.filename)) {
      const source = await commissionAction<{ url: string }>("file", {
        key: intake.source,
      });
      const response = await fetch(source.url);
      if (!response.ok) throw new Error("Could not read the original file.");
      if (/\.xlsx$/i.test(intake.filename))
        choose(
          readCommissionWorkbook(new Uint8Array(await response.arrayBuffer())),
        );
      else
        choose([
          {
            name: intake.filename,
            rows: parseStatementCsv(await response.text()),
          },
        ]);
    } else {
      const result = await commissionAction<{
        status: string;
        tables?: SourceTable[];
        text?: string;
      }>("extractIntakeDocument", { id: intake.id, version: intake.version });
      if (!alive.current) return;
      if (result.status === "PROCESSING") {
        setProcessing(true);
        task.setMessage(
          "Extracting the source. Progress checks continue automatically; your file is saved.",
        );
        if (!intake.extractionJobId) await refresh();
      } else {
        setProcessing(false);
        choose(result.tables ?? []);
        setText(result.text ?? "");
        task.setMessage(
          "Review all extracted values against the original before importing.",
        );
      }
    }
  };
  const readRef = useRef(read);
  readRef.current = read;
  useEffect(() => {
    alive.current = true;
    if (!rows.length || !!intake.extractionJobId || /\.(csv|xlsx)$/i.test(intake.filename)) void task.run(() => readRef.current());
    return () => { alive.current = false; };
  }, [intake.id, intake.source]);
  useEffect(() => {
    if (!processing || task.busy) return;
    if (pollCount >= 60) {
      setProcessing(false);
      task.setMessage("Extraction is taking longer than expected. Your source is saved; check again when ready.");
      return;
    }
    const timer = window.setTimeout(() => {
      void task.run(() => readRef.current()).then(ok => {
        if (!alive.current) return;
        if (!ok) setProcessing(false);
        setPollCount(n => n + 1);
      });
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [processing, pollCount, task.busy]);
  return (
    <div>
      <section className="intake-import-guide" aria-label="Source import instructions">
        <h3>{rows.length ? "Source import options" : "Next: check columns, then import"}</h3>
        <ol>
          <li><strong>Check the column choices.</strong> {template ? "The saved carrier format is selected." : "Recognizable headings are suggested automatically. A worksheet and header are selected when only one matches the required columns."} Correct any missing or incorrect choice.</li>
          <li><strong>Compare the preview with the original.</strong> Check policy numbers, references, amounts, dates and transaction types.</li>
          <li><strong>Confirm and import.</strong> Tick the confirmation below the preview, then choose <strong>Import rows &amp; remember format</strong>. You will continue to policy and eligibility review.</li>
        </ol>
        <p className="small">{rows.length ? "Rows have already been imported. Reimport only when you intend to replace editable rows from this table." : "The file is saved; its rows still need to be imported."} This step creates no earnings and records no payment.</p>
      </section>
      <div className="intake-actions">
        <Button
          variant="secondary"
          disabled={task.busy}
          onClick={() => { setPollCount(0); void task.run(read); }}
        >
          {task.busy
            ? "Reading…"
            : /\.(csv|xlsx)$/i.test(intake.filename)
              ? tables.length ? "Reload source file" : "Read saved spreadsheet"
              : intake.extractionJobId
                ? "Check PDF extraction"
                : "Extract PDF / image"}
        </Button>
        {intake.extractionJobId && (
          <Button
            variant="secondary"
            disabled={task.busy}
            onClick={() =>
              void task.run(async () => {
                await commissionAction("extractIntakeDocument", {
                  id: intake.id,
                  version: intake.version,
                  restart: true,
                  requestId: crypto.randomUUID(),
                });
                await refresh();
                setTables([]); setText(""); setReviewed(false);
                setPollCount(0); setProcessing(true);
                task.setMessage("New extraction started. Progress checks continue automatically.");
              })
            }
          >
            Restart extraction
          </Button>
        )}
      </div>
      <Feedback task={task} />
      {!!tables.length && (
        <>
          <details className="intake-source-options"><summary>Worksheet &amp; header options · {tables[sheet].name} · row {header + 1}</summary>
          <div className="form-grid">
            <label className="field">
              Table / worksheet
              <Select
                value={sheet}
                onChange={(e) => choose(tables, Number(e.target.value))}
              >
                {tables.map((t, i) => (
                  <option key={i} value={i}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </label>
            <label className="field">
              Header row
              <Input
                type="number"
                min={1}
                max={tables[sheet].rows.length - 1}
                value={header + 1}
                onChange={(e) =>
                  choose(tables, sheet, Math.max(0, Number(e.target.value) - 1))
                }
              />
            </label>
          </div>
          </details>
          {tables[sheet].confidence !== undefined && (
            <p className="small muted">
              Extraction confidence {tables[sheet].confidence!.toFixed(1)}%.
              Verify policy numbers, dates, signs and totals.
            </p>
          )}
          <div className="form-grid" id="intake-column-mapping">
            {(
              [
                ["policy", "Policy number"],
                ["reference", "Transaction reference"],
                ["amount", "Agency commission amount"],
                ["effective", "Policy effective date"],
                ["transaction", "Transaction type"],
              ] as const
            ).map(([key, label]) => (
              <label className="field" key={key}>
                {label}
                <Select
                  value={mapping[key]}
                  onChange={(e) => {
                    setMapping({ ...mapping, [key]: Number(e.target.value) });
                    setReviewed(false);
                  }}
                >
                  <option value={-1}>
                    {key === "effective" || key === "transaction"
                      ? "Not supplied"
                      : "Choose column"}
                  </option>
                  {table?.[0]?.map((name, i) => (
                    <option value={i} key={i}>
                      {name || "Column " + (i + 1)}
                    </option>
                  ))}
                </Select>
              </label>
            ))}
          </div>
          {issue && <p className="commission-notice">{issue}</p>}
          {!issue && (
            <>
              <p>
                <strong>
                  {preview.length} source rows ·{" "}
                  {money(sum(preview.map((r) => r.agencyCents ?? 0)))}
                </strong>{" "}
                · {preview.filter((r) => !r.policyId || r.importIssue).length}{" "}
                need matching or correction
              </p>
              <div className="commission-scroll">
                <Table>
                  <thead>
                    <tr>
                      <th>Source row</th>
                      <th>Policy</th>
                      <th>Reference</th>
                      <th>Agency amount</th>
                      <th>Review</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.slice(0, 10).map((r) => (
                      <tr key={r.id}>
                        <td>{r.sourceRow}</td>
                        <td>{r.policyNumber}</td>
                        <td>{r.lineRef}</td>
                        <td>
                          {r.agencyCents === undefined
                            ? r.raw?.[2]
                            : money(r.agencyCents)}
                        </td>
                        <td>
                          {r.importIssue ||
                            (r.policyId
                              ? "Suggested exact match"
                              : "Needs policy match")}
                          <span className="small muted">{r.effectiveDate || "No effective date"} · {r.transactionType}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
              {preview.length > 10 && (
                <p className="small muted">
                  First 10 rows shown. All {preview.length} rows will remain in
                  the statement for review.
                </p>
              )}
              <div className="intake-import-confirm">
              <h4>Confirm the preview to continue</h4>
              <p className="small">{reviewed ? "Ready to import. The next screen section is policy and eligibility review." : "The import button becomes available after you check the confirmation below."}</p>
              <label className="commission-check">
                <Input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(e) => setReviewed(e.target.checked)}
                />{" "}
                I checked the mapping against the original. Import these rows,
                replacing editable rows from this same table.
              </label>
              <div className="intake-actions">
                <Button
                  variant="primary"
                  disabled={!reviewed || task.busy || !preview.length}
                  onClick={() =>
                    void task.run(async () => {
                      await commissionAction("saveCarrierImportTemplate", { carrierId: intake.carrierId, version: template?.version ?? 0, headers: table![0], mapping });
                      try { await saveRows(preview, false); }
                      catch (error) { throw new Error('Carrier format saved; row import needs retry. ' + (error instanceof Error ? error.message : 'Refresh and review retained rows.')); }
                      setReviewed(false);
                      task.setMessage(
                        "Source rows saved. Review matches and eligibility below.",
                      );
                    })
                  }
                >
                  Import rows & remember format
                </Button>
              </div></div>
            </>
          )}
        </>
      )}
      {!!tables.length && <CommissionDraftRecovery compact intake={intake} scope="import" value={{ sheet, header, mapping }}
        restore={d => { if (tables[d.sheet]) { setSheet(d.sheet); setHeader(d.header); setMapping(d.mapping); setReviewed(false); } }}
        disabled={task.busy || processing} onError={onError}
        renderSaved={d => <dl className="intake-saved-values">
          <div><dt>Worksheet</dt><dd>{tables[d.sheet]?.name || "Worksheet unavailable"}</dd></div>
          <div><dt>Header row</dt><dd>{d.header + 1}</dd></div>
          {(Object.keys(importColumnLabels) as (keyof typeof importColumnLabels)[]).map(key => <div key={key}><dt>{importColumnLabels[key]}</dt><dd>{d.mapping[key] < 0 ? "Not selected" : tables[d.sheet]?.rows[d.header]?.[d.mapping[key]] || "Column unavailable"}</dd></div>)}
        </dl>} />}
      {text && (
        <CommissionPanel
          title="Extracted source text"
          hint="For checking or entering rows manually"
        >
          <pre className="intake-source-text">{text}</pre>
        </CommissionPanel>
      )}
    </div>
  );
}
function RowsEditor({
  detail,
  data,
  saveRows,
  renderPolicySetup,
  onError,
  onContinue,
}: {
  detail: Detail;
  data: CommissionOverview;
  saveRows: (rows: IntakeRow[], reviewed: boolean) => Promise<void>;
  renderPolicySetup: PolicySetup;
  onError: (e: unknown) => void;
  onContinue: () => void;
}) {
  const [drafts, setDrafts] = useState(detail.rows),
    [page, setPage] = useState(0),
    [selected, setSelected] = useState<string[]>([]),
    [confirmed, setConfirmed] = useState(false),
    [setupRow, setSetupRow] = useState(""),
    [showDetails, setShowDetails] = useState(false);
  const [amounts, setAmounts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      detail.rows.map((r) => [
        r.id,
        r.agencyCents === undefined ? "" : (r.agencyCents / 100).toFixed(2),
      ]),
    ),
  );
  const initialAmounts = useRef(JSON.stringify(amounts));
  const initial = useRef(JSON.stringify(detail.rows));
  const task = useTask(onError);
  const dirty =
    JSON.stringify(drafts) !== initial.current ||
    JSON.stringify(amounts) !== initialAmounts.current;
  const { markClean } = useUnsavedChanges(dirty, { busy: task.busy });
  const update = (id: string, value: Partial<IntakeRow>) => {
    setDrafts((prev) =>
      prev.map((r) => (r.id === id ? { ...r, ...value } : r)),
    );
    setConfirmed(false);
  };
  const locked = (r: IntakeRow) =>
    detail.settlements.some(
      (s) => s.status !== "VOID" && s.allocations.some((a) => a.rowId === r.id),
    );
  const [rowFilter, setRowFilter] = useCommissionPreference('rows-filter:' + detail.intake.id, 'unresolved');
  const [focusedRow, setFocusedRow] = useCommissionPreference('focused-row:' + detail.intake.id, '');
  const unresolved = (r: IntakeRow) => !locked(r) && (!r.deleted && (r.reviewStatus === 'PENDING' || !!rowIssues(r, detail.intake.carrierId, data.policies, drafts).length));
  const rowChanged = (r: IntakeRow) => JSON.stringify(r) !== JSON.stringify(detail.rows.find(old => old.id === r.id)) ||
    (amounts[r.id] ?? "") !== (r.agencyCents === undefined ? "" : (r.agencyCents / 100).toFixed(2));
  // Keep edited decisions on screen until saved, even when they no longer need review.
  const filtered = rowFilter === 'all' ? drafts : drafts.filter(r => unresolved(r) || rowChanged(r));
  const reviewed = statementStep(detail.intake, detail.settlements) >= 2;
  const reviewReady = drafts.length > 0 && !drafts.some(unresolved);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 10) - 1));
  const visible = filtered.slice(currentPage * 10, currentPage * 10 + 10);
  const focus = filtered.find(r => r.id === focusedRow)?.id ?? filtered[0]?.id;
  const mobileRow = filtered.find(r => r.id === focus);
  const displayed = mobileRow && !visible.some(r => r.id === mobileRow.id) ? [...visible, mobileRow] : visible;
  const routine = drafts.filter(r => !locked(r) && !r.deleted && r.reviewStatus === 'PENDING' && r.transactionType === 'RECEIPT' && !r.importIssue && (r.agencyCents ?? 0) > 0 && exactPolicyMatches(r,detail.intake.carrierId,data.policies).length === 1 && !rowIssues({...r,reviewStatus:'ELIGIBLE'},detail.intake.carrierId,data.policies,drafts).length);
  const missingGroups = [...new Map(drafts.filter(r=>!locked(r)&&!r.deleted&&!r.policyId).map(r=>[r.policyNumber+'|'+r.effectiveDate,r])).values()];
  useEffect(() => {
    setDrafts(prev => prev.map(r => {
      const matches=exactPolicyMatches(r, detail.intake.carrierId, data.policies);
      return !locked(r) && !r.policyId && !r.importIssue && matches.length===1 ? {...r,policyId:matches[0].id,reviewStatus:'PENDING'} : r;
    }));
    setConfirmed(false);
  }, [data.policies]);
  const add = () => {
    const id = crypto.randomUUID();
    setDrafts([
      ...drafts,
      {
        id,
        intakeId: detail.intake.id,
        version: 0,
        policyId: "",
        policyNumber: "",
        effectiveDate: "",
        lineRef: "",
        transactionType: "RECEIPT",
        reviewStatus: "PENDING",
        agencyCents: undefined,
        note: "",
        postedCents: 0,
      },
    ]);
    setRowFilter("all"); setFocusedRow(id); setShowDetails(true); setPage(Math.floor(drafts.length / 10));
  };
  const setup = drafts.find((r) => r.id === setupRow);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await task.run(async () => {
      const next = drafts.map((r) => ({
        ...r,
        agencyCents: amounts[r.id]?.trim()
          ? importedMoney(amounts[r.id])
          : r.agencyCents,
      }));
      const changed = next.filter(
        (r) =>
          !locked(r) &&
          JSON.stringify(r) !==
            JSON.stringify(detail.rows.find((old) => old.id === r.id)),
      );
      if (!changed.length) {
        task.setMessage("No row changes to save.");
        return;
      }
      if (changed.some((r) => r.reviewStatus !== "PENDING") && !confirmed)
        throw new Error(
          "Confirm the changed source values and eligibility decisions before saving reviewed rows.",
        );
      await saveRows(changed, confirmed);
      markClean();
    });
  };
  return (
    <section className="card intake-rows" id="intake-rows">
      <div className="commission-section-heading">
        <div>
          <h3 tabIndex={-1}>Policy matches & eligibility</h3>
          <p>
            Use agency commission paid on the statement. Rates and earnings come
            from the policy’s saved agreement.
          </p>
        </div>
        <Button
          variant="secondary"
          disabled={task.busy || drafts.length >= 1000}
          onClick={add}
        >
          Add source row
        </Button>
      </div>
      {reviewed && !dirty && <div className="intake-completion-note"><strong>All row decisions are saved.</strong><Button type="button" variant="primary" onClick={onContinue}>Continue to payment</Button><Button type="button" variant="secondary" onClick={() => setRowFilter("all")}>View reviewed rows</Button></div>}
      {!!drafts.length && detail.intake.totalCents !== detail.intake.rowTotalCents && <p role="alert" className="commission-notice">Check the statement control total above. It must equal the imported rows before continuing to payment.</p>}
      {!reviewed && <p className="intake-step-help">Check each policy, amount and employee rate below. Choose Eligible or Ineligible for each row, confirm your review, then save to continue. Open Edit details only to correct a row or explain an exception.</p>}
      <div className="intake-filters"><label className="field">Rows to review<Select value={rowFilter} onChange={e=>{setRowFilter(e.target.value);setPage(0);}}><option value="unresolved">Needs review or saving ({drafts.filter(r => unresolved(r) || rowChanged(r)).length})</option><option value="all">All rows ({drafts.length})</option></Select></label>
      <label className="field intake-mobile-picker" hidden={!showDetails || !filtered.length}>Focused source row<Select value={focus ?? ''} onChange={e=>setFocusedRow(e.target.value)}>{filtered.map(r=><option key={r.id} value={r.id}>{r.lineRef || r.policyNumber || 'New row'}</option>)}</Select></label></div>
      {!!missingGroups.length && <CommissionPanel title="Resolve missing policy groups" hint="Complete tracking once, then recheck every matching row">
        {missingGroups.map(r=><p key={r.id}>{r.policyNumber || 'Missing policy number'} · {r.effectiveDate || 'Term required if ambiguous'} · {drafts.filter(x=>x.policyNumber===r.policyNumber&&x.effectiveDate===r.effectiveDate&&!x.policyId).length} rows <Button variant="secondary" onClick={()=>setSetupRow(r.id)}>Find policy / complete tracking</Button></p>)}
      </CommissionPanel>}

      <form onSubmit={(e) => void submit(e)} hidden={!filtered.length && !dirty}>
        <fieldset disabled={task.busy}>
          <details className="intake-source-options"><summary>Group review tools</summary>
            {!!routine.length && <p className="small">{routine.length} routine rows have exact matches and no source issues. <Button type="button" variant="secondary" onClick={() => setSelected(routine.map(r => r.id))}>Select routine review group</Button></p>}
          <div className="intake-actions">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setDrafts((prev) =>
                  prev.map((r) => {
                    const matches = exactPolicyMatches(
                      r,
                      detail.intake.carrierId,
                      data.policies,
                    );
                    return !locked(r) && !r.policyId && matches.length === 1
                      ? {
                          ...r,
                          policyId: matches[0].id,
                          reviewStatus: "PENDING",
                        }
                      : r;
                  }),
                );
                setConfirmed(false);
              }}
            >
              Suggest exact matches
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={!selected.length}
              onClick={() => {
                setDrafts((prev) =>
                  prev.map((r) =>
                    selected.includes(r.id) &&
                    !locked(r) &&
                    r.transactionType === "RECEIPT" &&
                    r.policyId &&
                    !r.importIssue
                      ? { ...r, reviewStatus: "ELIGIBLE" }
                      : r,
                  ),
                );
                setConfirmed(false);
              }}
            >
              Mark selected routine rows eligible
            </Button>
          </div>
          </details>
          <div className="commission-scroll">
            <Table className="intake-review-overview" aria-label="Source row review">
              <thead><tr><th>Select</th><th>Policy / reference</th><th>Amount / employee</th><th>Review decision</th><th>Details</th></tr></thead>
              <tbody>{visible.map(r => {
                const policy = data.policies.find(p => p.id === r.policyId);
                const issues = rowIssues(r, detail.intake.carrierId, data.policies, drafts);
                return <tr key={r.id}>
                  <td><Input type="checkbox" aria-label={"Select source row " + (r.sourceRow ?? r.id)} disabled={locked(r) || r.deleted} checked={selected.includes(r.id)} onChange={e => { const checked = e.currentTarget.checked; setSelected(ids => checked ? [...ids, r.id] : ids.filter(id => id !== r.id)); }} /></td>
                  <td><strong>{r.policyNumber || "Policy needed"}</strong><span className="small muted">{r.lineRef || "Reference needed"}</span><span className="small muted">{r.effectiveDate || "Term not supplied"}</span>{!policy && <span className="error-text small">Match a policy in Edit details</span>}</td>
                  <td><strong>{displayCommissionAmount(amounts[r.id] ?? "") || "Amount needed"}</strong><span className="small muted">{policy ? `${policy.producerName} · ${policy.producerBps / 100}%` : "Employee not matched"}</span></td>
                  <td><Select aria-label={"Review decision " + r.id} disabled={locked(r) || r.deleted} value={r.reviewStatus} onChange={e => update(r.id, {reviewStatus:e.target.value as IntakeRow["reviewStatus"]})}><option value="PENDING">Needs review</option><option value="ELIGIBLE">Eligible</option><option value="INELIGIBLE">Ineligible</option></Select>{r.deleted ? <span className="small">Excluded</span> : issues.filter(issue => issue !== "Eligibility review required").map(issue => <span className="error-text small" key={issue}>{issue}</span>)}</td>
                  <td><Button type="button" variant="secondary" aria-label={"Edit details " + r.lineRef} onClick={() => {setFocusedRow(r.id); setShowDetails(true);}}>Edit details</Button></td>
                </tr>;
              })}</tbody>
            </Table>
          </div>
          <div hidden={!showDetails} className="intake-expanded-row">
            <div className="commission-section-heading"><h4>Row details</h4><Button type="button" variant="secondary" onClick={() => setShowDetails(false)}>Close row details</Button></div>
          <div className="commission-scroll">
            <Table className="intake-row-table">
              <thead>
                <tr>
                  <th>Source policy / reference</th>
                  <th>Policy match</th>
                  <th>Agency commission</th>
                  <th>Review</th>
                </tr>
              </thead>
              <tbody>
                {displayed.map((r) => {
                  let previewAmount = r.agencyCents;
                  try {
                    previewAmount = amounts[r.id]?.trim()
                      ? importedMoney(amounts[r.id])
                      : undefined;
                  } catch {
                    previewAmount = undefined;
                  }
                  const policy = data.policies.find((p) => p.id === r.policyId),
                    frozen = locked(r),
                    issues = rowIssues(
                      { ...r, agencyCents: previewAmount },
                      detail.intake.carrierId,
                      data.policies,
                      drafts,
                    );
                  return (
                    <tr
                      key={r.id}
                      className={(r.deleted ? "intake-excluded " : "") + (r.id === focus ? "intake-focused-row " : "") + (!visible.some(v=>v.id===r.id) ? "intake-mobile-only" : "")}
                    >
                      <td data-label="Source policy / reference">
                        <Input
                          aria-label={"Source policy " + r.id}
                          disabled={frozen}
                          placeholder="Policy number"
                          value={r.policyNumber}
                          onChange={(e) =>
                            update(r.id, {
                              policyNumber: e.target.value,
                              reviewStatus: "PENDING",
                            })
                          }
                        />
                        <Input
                          aria-label={"Transaction reference " + r.id}
                          disabled={frozen}
                          placeholder="Carrier transaction reference"
                          value={r.lineRef}
                          onChange={(e) =>
                            update(r.id, {
                              lineRef: e.target.value,
                              reviewStatus: "PENDING",
                            })
                          }
                        />
                        <Input
                          aria-label={"Source effective date " + r.id}
                          disabled={frozen}
                          type="date"
                          value={r.effectiveDate}
                          onChange={(e) =>
                            update(r.id, {
                              effectiveDate: e.target.value,
                              reviewStatus: "PENDING",
                            })
                          }
                        />
                        {r.raw && (
                          <details className="small muted intake-source-values"><summary>Source values as supplied</summary>{r.raw.filter(Boolean).join(" · ")}</details>
                        )}
                      </td>
                      <td data-label="Policy match">
                        <Select
                          aria-label={"Policy match " + r.id}
                          disabled={frozen}
                          value={r.policyId}
                          onChange={(e) =>
                            update(r.id, {
                              policyId: e.target.value,
                              reviewStatus: "PENDING",
                              originalId: undefined,
                            })
                          }
                        >
                          <option value="">Match a policy term</option>
                          {data.policies
                            .filter(
                              (p) => p.carrierId === detail.intake.carrierId,
                            )
                            .map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.accountName} · {p.policyNumber} ·{" "}
                                {p.effectiveDate}
                              </option>
                            ))}
                        </Select>
                        {policy && (
                          <span className="small muted">
                            {policy.producerName} · {policy.producerBps / 100}%
                            ·{" "}
                            {policy.transaction === "NEW"
                              ? "New business"
                              : "Renewal"}
                          </span>
                        )}
                        {!frozen && (
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={() => setSetupRow(r.id)}
                          >
                            Find in CRM / add tracking
                          </Button>
                        )}
                        {r.transactionType !== "RECEIPT" && (
                          <Select
                            aria-label={"Original receipt " + r.id}
                            disabled={frozen}
                            value={r.originalId ?? ""}
                            onChange={(e) =>
                              update(r.id, {
                                originalId: e.target.value,
                                reviewStatus: "PENDING",
                              })
                            }
                          >
                            <option value="">
                              Link original receipt / reversal
                            </option>
                            {policy?.entries.filter(isCarrierReceipt).map((entry) => (
                              <option key={entry.id} value={entry.id}>
                                {entry.lineRef} · {entry.receivedOn} ·{" "}
                                {money(entry.agencyCents)}
                              </option>
                            ))}
                          </Select>
                        )}
                      </td>
                      <td data-label="Agency commission">
                        <CurrencyInput
                          aria-label={"Agency amount " + r.id}
                          disabled={frozen}
                          placeholder="0.00"
                          value={amounts[r.id] ?? ""}
                          onChange={(e) => {
                            setAmounts({ ...amounts, [r.id]: e.target.value });
                            update(r.id, {
                              agencyCents: undefined,
                              reviewStatus: "PENDING",
                            });
                          }}
                        />
                        <Select
                          aria-label={"Transaction type " + r.id}
                          disabled={frozen}
                          value={r.transactionType}
                          onChange={(e) =>
                            update(r.id, {
                              transactionType: e.target
                                .value as IntakeRow["transactionType"],
                              reviewStatus: "PENDING",
                              originalId: undefined,
                            })
                          }
                        >
                          <option value="RECEIPT">Commission receipt</option>
                          <option value="REVERSAL">Reversal</option>
                          <option value="RESTORATION">Restoration</option>
                        </Select>
                        <span className="small muted">
                          {money(r.postedCents)} posted
                          {frozen ? " · Allocated row locked" : ""}
                        </span>
                      </td>
                      <td data-label="Review">
                        <Select
                          aria-label={"Eligibility " + r.id}
                          disabled={frozen}
                          value={r.reviewStatus}
                          onChange={(e) =>
                            update(r.id, {
                              reviewStatus: e.target
                                .value as IntakeRow["reviewStatus"],
                            })
                          }
                        >
                          <option value="PENDING">Needs review</option>
                          <option value="ELIGIBLE">Eligible</option>
                          <option value="INELIGIBLE">Ineligible</option>
                        </Select>
                        <Textarea
                          aria-label={"Review notes " + r.id}
                          disabled={frozen}
                          rows={2}
                          maxLength={2000}
                          placeholder="Notes for exceptions or exclusions"
                          value={r.note}
                          onChange={(e) =>
                            update(r.id, { note: e.target.value })
                          }
                        />
                        {r.importIssue && (
                          <span className="small error-text">
                            {r.importIssue}
                          </span>
                        )}
                        {!!issues.length && (
                          <span className="small muted">
                            {issues.join(" · ")}
                          </span>
                        )}
                        {!frozen && (
                          <label className="small commission-check">
                            <Input
                              type="checkbox"
                              checked={!!r.deleted}
                              onChange={(e) =>
                                update(r.id, { deleted: e.target.checked })
                              }
                            />{" "}
                            Exclude source row (reason required)
                          </label>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
          </div>
          {!drafts.length && (
            <p className="commission-compact-empty">
              Import the original statement or add a source row. Incomplete rows
              can be saved.
            </p>
          )}
          <div className="intake-actions" hidden={filtered.length <= 10}>
            <Button
              type="button"
              variant="secondary"
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
            >
              Previous rows
            </Button>
            <span className="small">
              Page {currentPage + 1} of {Math.max(1, Math.ceil(filtered.length / 10))}
            </span>
            <Button
              type="button"
              variant="secondary"
              disabled={(currentPage + 1) * 10 >= filtered.length}
              onClick={() => setPage(page + 1)}
            >
              Next rows
            </Button>
          </div>
          <label className="commission-check">
            <Input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />{" "}
            I checked changed source values, policy terms and eligibility
            decisions, including extracted values.
          </label>
          <div className="intake-actions">
            <Button variant="primary" disabled={!dirty}>
              {task.busy ? "Saving…" : reviewReady ? "Save review & continue" : "Save source rows"}
            </Button>
            <span className="small muted">
              {reviewReady ? "Save these decisions to move to carrier payment." : "Choose a review decision for every row. Pending rows can be saved for later."}
            </span>
          </div>
        </fieldset>
      </form>
      <CommissionDraftRecovery compact intake={detail.intake} scope="rows" value={{ drafts, amounts }}
        renderSaved={d => <ul>{d.drafts.map(r => <li key={r.id}>{r.policyNumber} · {r.lineRef} · {displayCommissionAmount(d.amounts[r.id] ?? "")} · {r.reviewStatus}</li>)}</ul>}
        restore={d => { setDrafts(d.drafts); setAmounts(d.amounts); setConfirmed(false); setSelected([]); setPage(0); }}
        disabled={task.busy} onError={onError} />
      <Feedback task={task} />
      {setup && (
        <CommissionPanel
          open
          title="Complete policy tracking here"
          hint="Existing CRM details are reused"
        >
          <Button variant="secondary" onClick={() => setSetupRow("")}>
            Close policy setup
          </Button>
          {renderPolicySetup(
            setup.policyNumber,
            detail.intake.carrierId,
            (policyId) => {
              // A single adoption can suggest all identical terms, while ambiguous terms stay unresolved.
              setDrafts(prev=>prev.map(r=>!locked(r)&&!r.policyId&&r.policyNumber.trim().toUpperCase()===setup.policyNumber.trim().toUpperCase()&&r.effectiveDate===setup.effectiveDate ? {...r,policyId,reviewStatus:'PENDING'}:r));
              setConfirmed(false);
              setSetupRow("");
            },
          )}
        </CommissionPanel>
      )}
    </section>
  );
}
function SettlementForm({
  intake,
  settlements,
  refresh,
  onError,
}: {
  intake: StatementIntake;
  settlements: IntakeSettlement[];
  refresh: () => Promise<void>;
  onError: (e: unknown) => void;
}) {
  const remaining = (intake.totalCents ?? 0) - sum(settlements.filter(s => s.status !== "VOID").map(s => s.totalCents));
  const suggestedAmount = useRef(remaining > 0 ? (remaining / 100).toFixed(2) : "").current;
  const [reference, setReference] = useState(""),
    [date, setDate] = useState(""),
    [amount, setAmount] = useState(suggestedAmount),
    [evidence, setEvidence] = useState(""),
    [type, setType] = useState("DEPOSIT"),
    [confirmed, setConfirmed] = useState(false);
  const task = useTask(onError);
  const { markClean } = useUnsavedChanges(
    !!reference || !!date || amount !== suggestedAmount || !!evidence || type !== "DEPOSIT" || confirmed,
    { busy: task.busy },
  );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void task.run(async () => {
          await commissionAction("recordIntakeSettlement", {
            id: intake.id,
            version: intake.version,
            reference,
            receivedOn: date,
            totalCents: importedMoney(amount),
            evidence,
            settlementType: type,
            confirmed,
          });
          markClean();
          setReference("");
          setDate("");
          setAmount("");
          setEvidence("");
          setConfirmed(false);
          await refresh();
        });
      }}
    >
      <fieldset disabled={task.busy}>
        <div className="form-grid">
          <Field
            label="Deposit / settlement reference"
            required
            value={reference}
            set={value => { setReference(value); setConfirmed(false); }}
          />
          <Field
            label="Actual commission receipt date"
            required
            type="date"
            value={date}
            set={value => { setDate(value); setConfirmed(false); }}
          />
          <Field
            label="Agency commission received / retained ($)"
            currency
            required
            value={amount}
            set={value => { setAmount(value); setConfirmed(false); }}
          />
          <label className="field">
            Settlement type
            <Select value={type} onChange={(e) => {setType(e.target.value); setConfirmed(false);}}>
              <option value="DEPOSIT">Carrier deposit</option>
              <option value="RETAINED">Agency-bill retained commission</option>
              <option value="NET_SETTLEMENT">Net settlement / offset</option>
            </Select>
          </label>
        </div>
        {!!suggestedAmount && <p className="small muted">Amount suggested from the unrecorded source balance: {displayCommissionAmount(suggestedAmount)}. Change it for a partial or different receipt; confirm against actual payment evidence.</p>}
        <label className="field">
          Payment evidence
          <Textarea
            required
            maxLength={2000}
            value={evidence}
            onChange={(e) => {setEvidence(e.target.value); setConfirmed(false);}}
            placeholder="Bank receipt, or collection and remittance evidence for retained commission"
          />
        </label>
        <label className="commission-check">
          <Input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />{" "}
          I verified that this settlement occurred on the date entered.
        </label>
        <Button variant="primary" disabled={!confirmed}>
          Save payment & continue
        </Button>
      </fieldset>
      <CommissionDraftRecovery compact intake={intake} scope="settlement" value={{ reference, date, amount, evidence, type }}
        renderSaved={d => <dl className="intake-saved-values">{Object.entries({...d,amount:displayCommissionAmount(d.amount)}).map(([key,value]) => <div key={key}><dt>{key}</dt><dd>{value || "Not entered"}</dd></div>)}</dl>}
        restore={d => { setReference(d.reference); setDate(d.date); setAmount(d.amount); setEvidence(d.evidence); setType(d.type); setConfirmed(false); }}
        disabled={task.busy} onError={onError} />
      <Feedback task={task} />
    </form>
  );
}
function SettlementCard({
  settlement: s,
  detail,
  data,
  refresh,
  onError,
}: {
  settlement: IntakeSettlement;
  detail: Detail;
  data: CommissionOverview;
  refresh: () => Promise<void>;
  onError: (e: unknown) => void;
}) {
  const reviewedAvailable = detail.rows.filter(r=>!r.deleted && r.agencyCents!==undefined && !rowIssues(r,detail.intake.carrierId,data.policies,detail.rows).length);
  const proposed: Record<string,string> = Object.fromEntries(reviewedAvailable.map(r=>[r.id, ((r.agencyCents! - reservedCents(r.id,detail.settlements,s.id))/100).toFixed(2)]).filter(([,v])=>Number(v)!==0));
  const fullPayment = s.status === "RECORDED" && sum(Object.values(proposed).map(importedMoney)) === s.totalCents && s.totalCents > 0 && Object.keys(proposed).length > 0;
  const [amounts, setAmounts] = useState<Record<string, string>>(() => s.status === "POSTING" ? Object.fromEntries(s.allocations.map(a => [a.rowId, (a.amountCents / 100).toFixed(2)])) : fullPayment ? proposed : {}),
    [confirmed, setConfirmed] = useState(false),
    [page, setPage] = useState(0);
  const task = useTask(onError);
  const request = useRef<string | null>(null);
  const initialAmounts = useRef(JSON.stringify(amounts));
  const { markClean } = useUnsavedChanges(
    ["RECORDED", "POSTING"].includes(s.status) && (JSON.stringify(amounts) !== initialAmounts.current || confirmed),
    { busy: task.busy },
  );
  const available = detail.rows.filter(
    (r) =>
      !r.deleted &&
      r.agencyCents !== undefined &&
      r.agencyCents !== reservedCents(r.id, detail.settlements, s.id),
  );
  const balance = (r: IntakeRow) =>
    r.agencyCents! - reservedCents(r.id, detail.settlements, s.id);
  let total = 0;
  let amountError = "";
  try {
    total = sum(
      Object.values(amounts)
        .filter((v) => v.trim())
        .map(importedMoney),
    );
  } catch {
    amountError = "Correct the allocated amounts.";
  }
  const allocationKey = JSON.stringify(amounts);
  const [previewKey, setPreviewKey] = useState(allocationKey);
  useEffect(()=>{const timer=window.setTimeout(()=>setPreviewKey(allocationKey),400);return()=>window.clearTimeout(timer);},[allocationKey]);
  type FinancialPreview = { token: string; employeeCents: number; calculations: { lineRef: string; producerName: string; producerBps: number; shareBps?: number; amountCents: number; reviewOnly: boolean }[] };
  const financial = useAsyncResource(async () => {
    if (!['RECORDED','POSTING'].includes(s.status) || amountError || total!==s.totalCents || previewKey!==allocationKey) return null;
    try { return await commissionAction<FinancialPreview>('previewIntakeSettlement',{id:detail.intake.id,settlementId:s.id,version:s.version,allocations:Object.entries(JSON.parse(previewKey) as Record<string,string>).filter(([,v])=>v.trim()).map(([rowId,v])=>({rowId,amountCents:importedMoney(v)}))}); }
    catch(error){onError(error);throw error;}
  }, [previewKey,s.version,detail.intake.version,data.policies], {clearDataOnError:()=>true,live:{topics:['OWNER'],protectEdits:true}});
  useEffect(() => setConfirmed(false), [financial.data?.token]);
  const previewReady = previewKey === allocationKey && !financial.loading && !!financial.data?.token && !!financial.data?.calculations && !financial.error;
  const post = async () => {
      const fresh = await commissionAction<Detail>("getStatementIntake", {
        id: detail.intake.id,
      });
      let current = fresh.settlements.find((x) => x.id === s.id);
      if (!current || !["POSTING", "POSTED"].includes(current.status))
        throw new Error(
          "Settlement no longer available. Refresh the statement.",
        );
      while (current.status === "POSTING") {
        request.current ??= crypto.randomUUID();
        const result = await commissionAction<{
          complete: boolean;
          postedRows: number;
          totalRows: number;
        }>("postIntakeSettlement", {
          id: detail.intake.id,
          settlementId: current.id,
          version: current.version,
          requestId: request.current,
          confirmed: true,
        });
        request.current = null;
        task.setMessage(
          "Posted " +
            result.postedRows +
            " of " +
            result.totalRows +
            " reviewed rows.",
        );
        if (result.complete) break;
        const latest = await commissionAction<Detail>("getStatementIntake", {
          id: detail.intake.id,
        });
        current = latest.settlements.find((x) => x.id === s.id)!;
      }
      markClean();
      await refresh();
    };
  return (
    <CommissionPanel
      title={
        <>
          {s.reference} · {money(s.totalCents)} ·{" "}
          {s.status === "POSTING"
            ? "Posting in progress"
            : s.status === "RECORDED"
              ? "Ready to allocate"
              : s.status === "POSTED"
                ? "Posted"
                : "Voided"}
        </>
      }
      open={["RECORDED", "POSTING"].includes(s.status)}
      hint={
        "Actual receipt " +
        s.receivedOn +
        " · " +
        s.postedRows.length +
        " rows posted"
      }
    >
      <details><summary>Payment evidence</summary><p>{s.evidence}</p></details>
      {s.status === "VOID" && <p>Void reason: {s.voidReason}</p>}
      {["RECORDED", "POSTING"].includes(s.status) && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void task.run(async () => {
              if (!previewReady) throw new Error("Wait for the current financial review before posting.");
              await commissionAction("allocateIntakeSettlement", {
                id: detail.intake.id,
                settlementId: s.id,
                version: s.version,
                confirmed,
                previewToken: financial.data!.token,
                allocations: Object.entries(amounts)
                  .filter(([, value]) => value.trim())
                  .map(([rowId, value]) => ({
                    rowId,
                    amountCents: importedMoney(value),
                  })),
              });
              try { await post(); }
              catch (error) {
                throw new Error("Allocation saved. Posting stopped; refresh this statement and review the remaining calculations. " + (error instanceof Error ? error.message : ""));
              }
            });
          }}
        >
          <fieldset disabled={task.busy}>
            {s.status === 'POSTING' && <p>{s.postedRows.length} rows are already posted. The saved allocation is fixed; review the employee calculations for the remaining rows.</p>}
            {fullPayment && <p className="commission-notice">This verified full payment matches the remaining reviewed balance. The complete allocation is proposed below; review it before posting.</p>}
            {!fullPayment && <p className="commission-notice">Partial or net payment: allocate only the amounts supported by payment evidence. No policy allocation is assumed.</p>}
            <p>
              Allocate this payment to the reviewed source rows. Enter a smaller
              amount for a partial payment.
            </p>
            <Button
              type="button"
              variant="secondary"
              disabled={s.status === 'POSTING'}
              onClick={() => {
                setAmounts(
                  Object.fromEntries(
                    available
                      .filter(
                        (r) =>
                          !rowIssues(
                            r,
                            detail.intake.carrierId,
                            data.policies,
                            detail.rows,
                          ).length,
                      )
                      .map((r) => [r.id, (balance(r) / 100).toFixed(2)]),
                  ),
                );
                setConfirmed(false);
              }}
            >
              Fill remaining reviewed amounts
            </Button>
            <div className="commission-scroll">
              <Table>
                <thead>
                  <tr>
                    <th>Policy / source transaction</th>
                    <th>Unallocated</th>
                    <th>This settlement ($)</th>
                  </tr>
                </thead>
                <tbody>
                  {available.slice(page * 20, page * 20 + 20).map((r) => (
                    <tr key={r.id}>
                      <td>
                        {r.policyNumber} · {r.lineRef}
                        <span className="small muted">
                          {rowIssues(
                            r,
                            detail.intake.carrierId,
                            data.policies,
                            detail.rows,
                          ).join(" · ")}
                        </span>
                      </td>
                      <td>{money(balance(r))}</td>
                      <td>
                        <CurrencyInput
                          aria-label={"Allocate " + r.lineRef}
                          disabled={s.status === 'POSTING'}
                          value={amounts[r.id] ?? ""}
                          onChange={(e) => {
                            setAmounts({ ...amounts, [r.id]: e.target.value });
                            setConfirmed(false);
                          }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
            <div className="intake-actions">
              <Button
                type="button"
                variant="secondary"
                disabled={!page}
                onClick={() => setPage(page - 1)}
              >
                Previous allocations
              </Button>
              <span>Page {page + 1}</span>
              <Button
                type="button"
                variant="secondary"
                disabled={(page + 1) * 20 >= available.length}
                onClick={() => setPage(page + 1)}
              >
                Next allocations
              </Button>
            </div>
            <p>
              <strong>
                Allocated {money(total)} / received {money(s.totalCents)}
              </strong>
              {total !== s.totalCents
                ? " · " + money(s.totalCents - total) + " difference"
                : " · Balanced"}
            </p>
            <p>Remaining after this payment: {detail.intake.totalCents===undefined?'Enter source total':money(detail.intake.totalCents-detail.intake.postedCents-(s.totalCents-sum(s.allocations.filter(a=>s.postedRows.includes(a.rowId)).map(a=>a.amountCents))))}</p>
            {amountError && <p className="error-text">{amountError}</p>}
            <Button type="button" variant="secondary" disabled={task.busy || financial.loading} onClick={()=>{setConfirmed(false);void financial.refetch();}}>Refresh employee calculations</Button>
            {financial.loading && total===s.totalCents && <p role="status">Checking employee calculations…</p>}
            {financial.error && <p role="alert">{financial.error}<Button type="button" variant="secondary" onClick={()=>void financial.refetch()}>Refresh financial review</Button></p>}
            {previewReady && <div className="commission-financial-summary"><strong>Employee earnings to post: {money(financial.data!.employeeCents)}</strong><details open><summary>Employee calculations</summary><ul>{financial.data!.calculations.map((c,i)=><li key={i}>{c.producerName} · {c.lineRef} · {c.shareBps===undefined?'':(c.shareBps/100)+'% share × '}{c.producerBps/100}% saved rate · {money(c.amountCents)}{c.reviewOnly?' — exception review; no automatic payroll change':''}</li>)}</ul></details></div>}
            <label className="commission-check">
              <Input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />{" "}
              I reviewed the source matches, eligibility and payment allocation. Post this verified settlement to earnings.
            </label>
            <Button
              variant="primary"
              disabled={!confirmed || !!amountError || total !== s.totalCents || !previewReady}
            >
              {s.status === 'POSTING' ? 'Confirm remaining calculations & resume posting' : 'Confirm allocation & post earnings'}
            </Button>
          </fieldset>
        </form>
      )}
      {s.status === "POSTING" && (
        <>
          <p>
            {s.postedRows.length} of {s.allocations.length} rows posted. This
            settlement continues to block affected payroll cutoffs until posting
            completes.
          </p>
          <p>Review the remaining employee calculations above and confirm to resume. Already posted rows are preserved.</p>
        </>
      )}
      {!s.postedRows.length && s.status !== "VOID" && (
        <CommissionPanel
          title="Correct an incorrectly recorded settlement"
          danger
        >
          <VoidForm
            label="Void incorrect settlement"
            action="voidIntakeSettlement"
            input={{
              id: detail.intake.id,
              settlementId: s.id,
              version: s.version,
            }}
            refresh={refresh}
            onError={onError}
          />
        </CommissionPanel>
      )}
      {s.status === "RECORDED" && <CommissionDraftRecovery compact intake={detail.intake} scope={"allocation-" + s.id} value={{ amounts }}
        renderSaved={d => <ul>{Object.entries(d.amounts).map(([id,amount]) => <li key={id}>{detail.rows.find(r => r.id === id)?.lineRef || id} · {displayCommissionAmount(amount) || "Not entered"}</li>)}</ul>}
        restore={d => { setAmounts(d.amounts); setConfirmed(false); }} disabled={task.busy} onError={onError} />}
      <Feedback task={task} />
    </CommissionPanel>
  );
}
function VoidForm({
  label,
  action,
  input,
  refresh,
  onError,
}: {
  label: string;
  action: CommissionOperationName;
  input: Record<string, unknown>;
  refresh: () => Promise<void>;
  onError: (e: unknown) => void;
}) {
  const [reason, setReason] = useState(""),
    [confirmed, setConfirmed] = useState(false);
  const task = useTask(onError);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void task.run(async () => {
          await commissionAction(action, { ...input, reason, confirmed });
          await refresh();
        });
      }}
    >
      <fieldset disabled={task.busy}>
        <label className="field">
          Reason and supporting evidence
          <Textarea
            required
            maxLength={2000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <label className="commission-check">
          <Input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />{" "}
          I confirm this record is incorrect and should remain in history as
          voided.
        </label>
        <Button
          variant="danger" className="payroll--button"
          disabled={!confirmed}
        >
          {label}
        </Button>
      </fieldset>
      <Feedback task={task} />
    </form>
  );
}
