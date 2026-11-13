import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { commissionAction } from "../lib/commissions";
import { attachCommissionStatement } from "../lib/commissionStatementAttachment";
import { readCommissionWorkbook } from "../lib/commissionWorkbook";
import { useAsyncResource } from "../lib/useAsyncResource";
import { useEditProtection, useUnsavedChanges } from "../lib/editProtection";
import { isAuthorizationError } from "../lib/authorizationError";
import {
  parseStatementCsv,
  emptyImportMapping,
  importedMoney,
} from "../../../shared/commissionImport";
import {
  exactPolicyMatches,
  prepareIntakeRows,
  reservedCents,
  reuseImportMapping,
  rowIssues,
  type StatementIntake,
  type IntakeRow,
  type IntakeSettlement,
  type CarrierImportTemplate,
  type IntakeWorkspace,
} from "../../../shared/commissionIntake";
import { sum, type CommissionOverview } from "../../../shared/commissions";
import CommissionPanel from "./CommissionPanel";
import "./CommissionIntake.css";

const money = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );
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
  return (
    <>
      {task.error && (
        <p className="error-text" role="alert">
          {task.error}
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
function Field({
  label,
  value,
  set,
  type = "text",
  required = false,
}: {
  label: string;
  value: string;
  set: (v: string) => void;
  type?: string;
  required?: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type={type}
        value={value}
        required={required}
        onChange={(e) => set(e.target.value)}
      />
    </label>
  );
}
const phase = (s: StatementIntake, settlements: IntakeSettlement[]) =>
  s.status === "VOID"
    ? "Voided"
    : s.rowCount > 0 && s.completedRows === s.rowCount
      ? "Posted"
      : settlements.some(
            (x) =>
              x.intakeId === s.id && ["RECORDED", "POSTING"].includes(x.status),
          )
        ? "Settlement needs review"
        : s.needsReview ||
            !s.rowCount ||
            s.totalCents === undefined ||
            s.totalCents !== s.rowTotalCents
          ? "Needs matching / review"
          : "Awaiting payment";

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
  const resource = useAsyncResource(
    () => commissionAction<IntakeWorkspace>("intakeWorkspace", {}),
    [],
    { clearDataOnError: () => true },
  );
  const { requestLeave } = useEditProtection();
  const [selected, setSelected] = useState(""),
    [adding, setAdding] = useState(false),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState("active");
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
          <button className="secondary" onClick={() => void resource.refetch()}>
            Retry statement inbox
          </button>
        )}
      </div>
    );
  const items = workspace.intakes.filter(
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
        <button
          className="primary"
          onClick={() =>
            requestLeave(() => {
              setAdding(true);
              setSelected("");
            })
          }
        >
          Log carrier statement
        </button>
      </div>
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
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
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
          </select>
        </label>
        <button
          className="secondary"
          onClick={() => requestLeave(() => void refresh())}
        >
          Refresh inbox
        </button>
      </div>
      <div className="commission-scroll">
        <table>
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
                  <button
                    className="secondary"
                    onClick={() =>
                      requestLeave(() => {
                        setSelected(s.id);
                        setAdding(false);
                      })
                    }
                  >
                    Open
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!items.length && (
          <p className="commission-compact-empty">
            No statements in this view.
          </p>
        )}
      </div>
      {selected && (
        <IntakeDetail
          key={selected}
          id={selected}
          data={data}
          templates={workspace.templates}
          refresh={refresh}
          renderPolicySetup={renderPolicySetup}
          onError={denied}
          close={() => requestLeave(() => setSelected(""))}
        />
      )}
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
            <select
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
            </select>
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
            <input
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
          <button className="primary">
            {task.busy ? "Saving…" : "Save to inbox"}
          </button>
          <button type="button" className="secondary" onClick={cancel}>
            Cancel
          </button>
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
    () => commissionAction<Detail>("getStatementIntake", { id }),
    [id],
    { clearDataOnError: () => true },
  );
  const task = useTask(onError),
    detail = resource.data;
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
  };
  if (!detail)
    return (
      <div className="card">
        <p role={resource.error ? "alert" : undefined}>
          {resource.error || "Opening statement…"}
        </p>
        <button className="secondary" onClick={() => void resource.refetch()}>
          Retry
        </button>
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
          <button
            className="secondary"
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
          </button>
          <button className="secondary" onClick={close}>
            Close statement
          </button>
        </div>
      </div>
      <Feedback task={task} />
      {intake.status === "VOID" ? (
        <p className="commission-notice">Voided: {intake.voidReason}</p>
      ) : (
        <>
          <HeaderEditor
            key={
              "header-" + intake.totalCents + ":" + (intake.statementDate ?? "")
            }
            intake={intake}
            refresh={reload}
            onError={onError}
          />
          <CommissionPanel
            title="Import statement rows"
            hint="Reuse a carrier format or extract a PDF"
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
          <RowsEditor
            key={"rows-" + rows.map((r) => r.id + ":" + r.version).join(",")}
            detail={detail}
            data={data}
            saveRows={saveRows}
            renderPolicySetup={renderPolicySetup}
            onError={onError}
          />
          <section className="card">
            <div className="commission-section-heading">
              <div>
                <h3>Payment & settlement</h3>
                <p>
                  Record actual agency commission received or retained. The
                  statement received date does not establish payment.
                </p>
              </div>
            </div>
            <CommissionPanel
              title="Record a settlement"
              hint="Supports partial payments and net offsets"
            >
              <SettlementForm
                intake={intake}
                refresh={reload}
                onError={onError}
              />
            </CommissionPanel>
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
            {!settlements.length && (
              <p className="small muted">
                No payment recorded. This statement does not create earnings or
                block payroll while awaiting payment.
              </p>
            )}
          </section>
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
            <span className={difference ? "error-text small" : "small muted"}>
              {difference === undefined
                ? "Enter the source total before posting."
                : difference
                  ? money(difference) + " difference to resolve"
                  : "Statement total reconciles"}
            </span>
          </div>
        </div>
        <button className="secondary">Save statement details</button>
      </fieldset>
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
    [text, setText] = useState("");
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
  const choose = (next: SourceTable[], index = 0, head = 0) => {
    setTables(next);
    setSheet(index);
    setHeader(head);
    setMapping(reuseImportMapping(next[index]?.rows[head] ?? [], template));
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
      if (result.status === "PROCESSING") {
        task.setMessage(
          "Extraction is processing. Check again shortly; your source file is saved.",
        );
        await refresh();
      } else {
        choose(result.tables ?? []);
        setText(result.text ?? "");
        task.setMessage(
          "Review all extracted values against the original before importing.",
        );
      }
    }
  };
  return (
    <div>
      <p className="small muted">
        Saved carrier formats match columns by heading. Imports preserve
        unmatched and invalid rows for review; they never create earnings.
      </p>
      <div className="intake-actions">
        <button
          className="secondary"
          disabled={task.busy}
          onClick={() => void task.run(read)}
        >
          {task.busy
            ? "Reading…"
            : /\.(csv|xlsx)$/i.test(intake.filename)
              ? "Read saved spreadsheet"
              : intake.extractionJobId
                ? "Check PDF extraction"
                : "Extract PDF / image"}
        </button>
        {intake.extractionJobId && (
          <button
            className="secondary"
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
                task.setMessage("New extraction started. Check again shortly.");
              })
            }
          >
            Restart extraction
          </button>
        )}
      </div>
      <Feedback task={task} />
      {!!tables.length && (
        <>
          <div className="form-grid">
            <label className="field">
              Table / worksheet
              <select
                value={sheet}
                onChange={(e) => choose(tables, Number(e.target.value))}
              >
                {tables.map((t, i) => (
                  <option key={i} value={i}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Header row
              <input
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
          {tables[sheet].confidence !== undefined && (
            <p className="small muted">
              Extraction confidence {tables[sheet].confidence!.toFixed(1)}%.
              Verify policy numbers, dates, signs and totals.
            </p>
          )}
          <div className="form-grid">
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
                <select
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
                </select>
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
                <table>
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
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preview.length > 10 && (
                <p className="small muted">
                  First 10 rows shown. All {preview.length} rows will remain in
                  the statement for review.
                </p>
              )}
              <label className="commission-check">
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(e) => setReviewed(e.target.checked)}
                />{" "}
                I checked the mapping against the original. Import these rows,
                replacing editable rows from this same table.
              </label>
              <div className="intake-actions">
                <button
                  className="primary"
                  disabled={!reviewed || task.busy || !preview.length}
                  onClick={() =>
                    void task.run(async () => {
                      await saveRows(preview, false);
                      setReviewed(false);
                      task.setMessage(
                        "Source rows saved. Review matches and eligibility below.",
                      );
                    })
                  }
                >
                  Import rows for review
                </button>
                <button
                  className="secondary"
                  disabled={!reviewed || task.busy}
                  onClick={() =>
                    void task.run(async () => {
                      await commissionAction("saveCarrierImportTemplate", {
                        carrierId: intake.carrierId,
                        version: template?.version ?? 0,
                        headers: table![0],
                        mapping,
                      });
                      await refresh();
                      task.setMessage("Carrier column mapping saved.");
                    })
                  }
                >
                  Remember carrier format
                </button>
              </div>
            </>
          )}
        </>
      )}
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
}: {
  detail: Detail;
  data: CommissionOverview;
  saveRows: (rows: IntakeRow[], reviewed: boolean) => Promise<void>;
  renderPolicySetup: PolicySetup;
  onError: (e: unknown) => void;
}) {
  const [drafts, setDrafts] = useState(detail.rows),
    [page, setPage] = useState(0),
    [selected, setSelected] = useState<string[]>([]),
    [confirmed, setConfirmed] = useState(false),
    [setupRow, setSetupRow] = useState("");
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
  const visible = drafts.slice(page * 10, page * 10 + 10);
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
    setPage(Math.floor(drafts.length / 10));
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
    <section className="card intake-rows">
      <div className="commission-section-heading">
        <div>
          <h3>Policy matches & eligibility</h3>
          <p>
            Use agency commission paid on the statement. Rates and earnings come
            from the policy’s saved agreement.
          </p>
        </div>
        <button
          className="secondary"
          disabled={task.busy || drafts.length >= 1000}
          onClick={add}
        >
          Add source row
        </button>
      </div>
      <form onSubmit={(e) => void submit(e)}>
        <fieldset disabled={task.busy}>
          <div className="intake-actions">
            <button
              type="button"
              className="secondary"
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
            </button>
            <button
              type="button"
              className="secondary"
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
            </button>
          </div>
          <div className="commission-scroll">
            <table className="intake-row-table">
              <thead>
                <tr>
                  <th>Select</th>
                  <th>Source policy / reference</th>
                  <th>Policy match</th>
                  <th>Agency commission</th>
                  <th>Review</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
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
                      className={r.deleted ? "intake-excluded" : ""}
                    >
                      <td>
                        <input
                          type="checkbox"
                          aria-label={
                            "Select source row " + (r.sourceRow ?? r.id)
                          }
                          disabled={frozen || r.deleted}
                          checked={selected.includes(r.id)}
                          onChange={(e) =>
                            setSelected((ids) =>
                              e.target.checked
                                ? [...ids, r.id]
                                : ids.filter((id) => id !== r.id),
                            )
                          }
                        />
                        <div className="small muted">
                          {r.sourceRow ? "Row " + r.sourceRow : "Manual"}
                        </div>
                      </td>
                      <td>
                        <input
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
                        <input
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
                        <input
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
                          <span className="small muted intake-source-values">
                            Source: {r.raw.filter(Boolean).join(" · ")}
                          </span>
                        )}
                      </td>
                      <td>
                        <select
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
                        </select>
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
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => setSetupRow(r.id)}
                          >
                            Find in CRM / add tracking
                          </button>
                        )}
                        {r.transactionType !== "RECEIPT" && (
                          <select
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
                            {policy?.entries.map((entry) => (
                              <option key={entry.id} value={entry.id}>
                                {entry.lineRef} · {entry.receivedOn} ·{" "}
                                {money(entry.agencyCents)}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td>
                        <input
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
                        <select
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
                        </select>
                        <span className="small muted">
                          {money(r.postedCents)} posted
                          {frozen ? " · Allocated row locked" : ""}
                        </span>
                      </td>
                      <td>
                        <select
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
                        </select>
                        <textarea
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
                            <input
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
            </table>
          </div>
          {!drafts.length && (
            <p className="commission-compact-empty">
              Import the original statement or add a source row. Incomplete rows
              can be saved.
            </p>
          )}
          <div className="intake-actions">
            <button
              type="button"
              className="secondary"
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
            >
              Previous rows
            </button>
            <span className="small">
              Page {page + 1} of {Math.max(1, Math.ceil(drafts.length / 10))}
            </span>
            <button
              type="button"
              className="secondary"
              disabled={(page + 1) * 10 >= drafts.length}
              onClick={() => setPage(page + 1)}
            >
              Next rows
            </button>
          </div>
          <label className="commission-check">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />{" "}
            I checked changed source values, policy terms and eligibility
            decisions, including extracted values.
          </label>
          <div className="intake-actions">
            <button className="primary" disabled={!dirty}>
              {task.busy ? "Saving…" : "Save source rows"}
            </button>
            <span className="small muted">
              Pending rows can be saved without completing review.
            </span>
          </div>
        </fieldset>
      </form>
      <Feedback task={task} />
      {setup && (
        <CommissionPanel
          open
          title="Complete policy tracking here"
          hint="Existing CRM details are reused"
        >
          <button className="secondary" onClick={() => setSetupRow("")}>
            Close policy setup
          </button>
          {renderPolicySetup(
            setup.policyNumber,
            detail.intake.carrierId,
            (policyId) => {
              update(setup.id, { policyId, reviewStatus: "PENDING" });
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
  refresh,
  onError,
}: {
  intake: StatementIntake;
  refresh: () => Promise<void>;
  onError: (e: unknown) => void;
}) {
  const [reference, setReference] = useState(""),
    [date, setDate] = useState(""),
    [amount, setAmount] = useState(""),
    [evidence, setEvidence] = useState(""),
    [type, setType] = useState("DEPOSIT"),
    [confirmed, setConfirmed] = useState(false);
  const task = useTask(onError);
  const { markClean } = useUnsavedChanges(
    !!reference || !!date || !!amount || !!evidence,
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
            set={setReference}
          />
          <Field
            label="Actual commission receipt date"
            required
            type="date"
            value={date}
            set={setDate}
          />
          <Field
            label="Agency commission received / retained ($)"
            required
            value={amount}
            set={setAmount}
          />
          <label className="field">
            Settlement type
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="DEPOSIT">Carrier deposit</option>
              <option value="RETAINED">Agency-bill retained commission</option>
              <option value="NET_SETTLEMENT">Net settlement / offset</option>
            </select>
          </label>
        </div>
        <label className="field">
          Payment evidence
          <textarea
            required
            maxLength={2000}
            value={evidence}
            onChange={(e) => setEvidence(e.target.value)}
            placeholder="Bank receipt, or collection and remittance evidence for retained commission"
          />
        </label>
        <label className="commission-check">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />{" "}
          I verified that this settlement occurred on the date entered.
        </label>
        <button className="primary" disabled={!confirmed}>
          Save settlement for allocation
        </button>
      </fieldset>
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
  const [amounts, setAmounts] = useState<Record<string, string>>({}),
    [confirmed, setConfirmed] = useState(false),
    [page, setPage] = useState(0);
  const task = useTask(onError);
  const request = useRef<string | null>(null);
  const { markClean } = useUnsavedChanges(
    Object.values(amounts).some(Boolean) || confirmed,
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
  const post = () =>
    task.run(async () => {
      const fresh = await commissionAction<Detail>("getStatementIntake", {
        id: detail.intake.id,
      });
      let current = fresh.settlements.find((x) => x.id === s.id);
      if (!current)
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
    });
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
      hint={
        "Actual receipt " +
        s.receivedOn +
        " · " +
        s.postedRows.length +
        " rows posted"
      }
    >
      <p className="small">Evidence: {s.evidence}</p>
      {s.status === "VOID" && <p>Void reason: {s.voidReason}</p>}
      {s.status === "RECORDED" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void task.run(async () => {
              await commissionAction("allocateIntakeSettlement", {
                id: detail.intake.id,
                settlementId: s.id,
                version: s.version,
                confirmed,
                allocations: Object.entries(amounts)
                  .filter(([, value]) => value.trim())
                  .map(([rowId, value]) => ({
                    rowId,
                    amountCents: importedMoney(value),
                  })),
              });
              markClean();
              await refresh();
            });
          }}
        >
          <fieldset disabled={task.busy}>
            <p>
              Allocate this payment to the reviewed source rows. Enter a smaller
              amount for a partial payment.
            </p>
            <button
              type="button"
              className="secondary"
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
            </button>
            <div className="commission-scroll">
              <table>
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
                        <input
                          aria-label={"Allocate " + r.lineRef}
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
              </table>
            </div>
            <div className="intake-actions">
              <button
                type="button"
                className="secondary"
                disabled={!page}
                onClick={() => setPage(page - 1)}
              >
                Previous allocations
              </button>
              <span>Page {page + 1}</span>
              <button
                type="button"
                className="secondary"
                disabled={(page + 1) * 20 >= available.length}
                onClick={() => setPage(page + 1)}
              >
                Next allocations
              </button>
            </div>
            <p>
              <strong>
                Allocated {money(total)} / received {money(s.totalCents)}
              </strong>
              {total !== s.totalCents
                ? " · " + money(s.totalCents - total) + " difference"
                : " · Balanced"}
            </p>
            {amountError && <p className="error-text">{amountError}</p>}
            <label className="commission-check">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />{" "}
              I reviewed the source matches, eligibility and payment allocation.
            </label>
            <button
              className="primary"
              disabled={!confirmed || !!amountError || total !== s.totalCents}
            >
              Confirm allocation
            </button>
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
          <button
            className="primary"
            disabled={task.busy}
            onClick={() => void post()}
          >
            {task.busy
              ? "Posting reviewed rows…"
              : s.postedRows.length
                ? "Resume posting"
                : "Post verified settlement"}
          </button>
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
  action: string;
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
          <textarea
            required
            maxLength={2000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <label className="commission-check">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />{" "}
          I confirm this record is incorrect and should remain in history as
          voided.
        </label>
        <button
          className="secondary payroll-danger-button"
          disabled={!confirmed}
        >
          {label}
        </button>
      </fieldset>
      <Feedback task={task} />
    </form>
  );
}
