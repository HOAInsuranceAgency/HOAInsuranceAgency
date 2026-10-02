import { useMemo, useState } from "react";
import {
  client,
  fmtDateTime,
  fmtMoney,
  listAllPages,
  type Activity,
} from "../../lib/client";
import { useAsyncResource } from "../../lib/useAsyncResource";
import { communicationRequest, type Communication } from "../../lib/communications";
import { isAuthorizationError } from "../../lib/authorizationError";
import LeadWorkflowPanel from "../../components/LeadWorkflowPanel";
import { fieldLabel } from "../../../amplify/functions/activity-log/diff";
import "./ActivityTab.css";

/**
 * Account-change history, newest first, below the communication workspace.
 *
 * The `Activity` model grants signed-in users read access only. Its rows are
 * written by the stream handler and backend services as IAM principals.
 * Internal notes live in Communication records; their audit rows contain a
 * reference, so opening a note reads its text through the account-scoped API.
 *
 * ## What the timeline can and cannot tell you
 *
 * Capture is complete — a write that reached the table is a row here,
 * including one made by a Lambda, the backfill script, or somebody with the
 * console open. Attribution is not: it rides on `lastWriteBy`, which the
 * actor proxy stamps on creates and updates. A **delete** carries only an id,
 * so it has nowhere to put an actor and is recorded as System.
 */

interface ChangeRow {
  field: string;
  from: unknown;
  to: unknown;
}

/** `a.json()` comes back as a string or as parsed JSON depending on the path. */
function readChanges(raw: unknown): ChangeRow[] {
  let v: unknown = raw;
  try {
    if (typeof v === "string") v = JSON.parse(v);
  } catch {
    return [];
  }
  return Array.isArray(v) ? (v as ChangeRow[]) : [];
}

function internalNoteId(activity: Activity, changes: ChangeRow[]): string | undefined {
  if (activity.subjectType !== "Lead communication" || activity.summary !== "Internal note added") return;
  const id = changes.find(change => change?.field === "id")?.to;
  return typeof id === "string" && id.startsWith("note:") && id.length > 5 ? id : undefined;
}

/**
 * A stored value as the timeline shows it.
 *
 * Money is the case worth handling: a change from 4200000 to 4500000 is
 * unreadable, and $4,200,000 → $4,500,000 is the point of the row. Which
 * fields are money is decided by name, because the diff carries no types —
 * the alternative is threading a schema into the stream handler for the sake
 * of a comma.
 */
const MONEY_FIELD = /(amount|premium|limit|value|deductible|retention|revenue|paid|reserved)$/i;

function renderValue(field: string, v: unknown): string {
  if (v == null || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "object") return JSON.stringify(v, null, 2);
  if (typeof v === "number" && MONEY_FIELD.test(field)) return fmtMoney(v);
  return String(v);
}

const USER_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const actorKey = (r: Activity) => r.actor || r.actorName || "System";
const needsName = (r: Activity) => !!r.actor && USER_ID.test(r.actor) &&
  (!r.actorName || r.actorName === r.actor || r.actorName === "Unknown user");

export function ActivityTab({ accountId }: { accountId: string }) {
  return (
    <>
      <div id="lead-workspace"><LeadWorkflowPanel key={accountId} accountId={accountId} /></div>
      <AccountChanges key={accountId} accountId={accountId} />
    </>
  );
}

function AccountChanges({ accountId }: { accountId: string }) {
  const res = useAsyncResource(
    () =>
      listAllPages((nextToken) =>
        client.models.Activity.listActivityByEntityIdAndOccurredAt(
          { entityId: accountId },
          // Newest first, off the index rather than sorted in the browser —
          // an account edited daily for a year is thousands of rows.
          { sortDirection: "DESC", nextToken }
        )
      ),
    [accountId],
    { initialData: [] as Activity[], errorMessage: "Failed to load activity" }
  );

  const [subjectFilter, setSubjectFilter] = useState("");
  const [actorFilter, setActorFilter] = useState("");

  const rows = res.data;
  const waitingForRows = !res.loaded || (res.loading && rows.length === 0);
  // Resolve old communication rows without changing their immutable audit data.
  // A profile lookup failure must not hide the account's activity.
  const unresolvedActors = useMemo(
    () => [...new Set(rows.filter(needsName).map((r) => r.actor!))].sort(),
    [rows]
  );
  const names = useAsyncResource(async () => {
    const entries: [string, string][] = [];
    for (const userId of unresolvedActors) {
      const profiles = await listAllPages((nextToken) =>
        client.models.UserProfile.listUserProfileByUserId({ userId }, { nextToken })
      );
      const profile = profiles[0];
      const name = [profile?.firstName, profile?.lastName].filter(Boolean).join(" ").trim();
      entries.push([userId, name || profile?.email || "Unknown teammate"]);
    }
    return Object.fromEntries(entries);
  }, [unresolvedActors], { initialData: {} as Record<string, string>, errorMessage: "Teammate names could not be loaded." });
  const actorLabel = (r: Activity) => needsName(r)
    ? names.data[r.actor!] || "Unknown teammate"
    : r.actorName || (r.actor ? "Unknown teammate" : "System");
  const subjects = useMemo(
    () => [...new Set(rows.map((r) => r.subjectType))].sort(),
    [rows]
  );
  const actors = useMemo(
    () => [...new Map(rows.map((r) => [actorKey(r), { key: actorKey(r), label: actorLabel(r) }])).values()]
      .sort((a, b) => a.label.localeCompare(b.label)),
    [rows, names.data]
  );
  const filtered = rows.filter(
    (r) =>
      (!subjectFilter || r.subjectType === subjectFilter) &&
      (!actorFilter || actorKey(r) === actorFilter)
  );

  return (
    <section className="card account-changes" aria-label="Account changes">
      <div className="account-changes-heading">
        <div>
          <h2>Account changes {!waitingForRows && !res.error && <span className="account-changes-count">{rows.length}</span>}</h2>
          <p>Updates to this account and its related records.</p>
        </div>
        <span className="account-changes-order">Newest first</span>
      </div>

      {waitingForRows ? (
        <p className="account-changes-state" role="status">Loading account changes…</p>
      ) : res.error ? (
        <div className="account-changes-state account-changes-state--error" role="alert">
          <p>{res.error}</p>
          <button className="secondary" onClick={() => void res.refetch()}>Retry account changes</button>
        </div>
      ) : rows.length === 0 ? (
        <div className="account-changes-state">
          <strong>No account changes yet</strong>
          <p>Changes to this account will appear here.</p>
        </div>
      ) : (
        <>
          {names.error && <p className="account-changes-notice">Activity is available, but some teammate names could not be loaded. <button className="btn secondary small" onClick={() => void names.refetch()}>Retry names</button></p>}
          <div className="account-changes-filters">
            <div className="field">
              <label htmlFor="activity-subject">Subject</label>
              <select
                id="activity-subject"
                value={subjectFilter}
                onChange={(e) => setSubjectFilter(e.target.value)}
              >
                <option value="">All</option>
                {subjects.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="activity-actor">Who</label>
              <select
                id="activity-actor"
                value={actorFilter}
                onChange={(e) => setActorFilter(e.target.value)}
              >
                <option value="">Anyone</option>
                {actors.map((a) => (
                  <option key={a.key} value={a.key}>{a.label}</option>
                ))}
              </select>
            </div>
            <span className="account-changes-results" role="status">{filtered.length} of {rows.length} changes</span>
          </div>

          {filtered.length === 0 ? (
            <p className="account-changes-state">Nothing matches those filters.</p>
          ) : (
            <div className="table-wrap account-changes-table-wrap">
              <table className="account-changes-table" aria-label="Account change history">
                <colgroup><col className="account-change-when" /><col className="account-change-who" /><col className="account-change-what" /><col /></colgroup>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Who</th>
                    <th>Record</th>
                    <th>Change</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => {
                    const changes = readChanges(r.changes);
                    return (
                      <tr key={r.id}>
                        <td className="account-change-date">{fmtDateTime(r.occurredAt)}</td>
                        <td className="account-change-actor">{actorLabel(r)}</td>
                        <td>
                          <div className="account-change-type">
                            <span className="account-change-subject">{r.subjectType}</span>
                            <span className="badge gray account-change-action">{({ CREATE: "Added", UPDATE: "Updated", DELETE: "Deleted" } as Record<string, string>)[r.action] ?? r.action}</span>
                          </div>
                          {r.subjectLabel && <span className="account-change-record">{r.subjectLabel}</span>}
                        </td>
                        <td>
                          <ChangeDetails accountId={accountId} summary={r.summary} changes={changes} noteId={internalNoteId(r, changes)} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** Keep large before/after values out of the DOM until their row is opened. */
function ChangeDetails({ accountId, summary, changes, noteId }: { accountId: string; summary: Activity["summary"]; changes: ChangeRow[]; noteId?: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <details className="account-change-details" onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary>
        <span className="account-change-summary">{summary}</span>
        <span className="account-change-expand">{noteId ? "View note" : changes.length ? `${changes.length} field change${changes.length === 1 ? "" : "s"}` : "View details"}</span>
      </summary>
      {expanded && (noteId ? <InternalNoteContent key={`${accountId}:${noteId}`} accountId={accountId} noteId={noteId} /> : changes.length ? (
        <dl className="account-change-fields">
          {changes.map((c, index) => (
            <div className="account-change-field" key={`${c.field}-${index}`}>
              <dt>{fieldLabel(c.field)}</dt>
              <dd>
                <div><span className="account-change-value-label">Before</span><span className="account-change-value">{renderValue(c.field, c.from)}</span></div>
                <div><span className="account-change-value-label">After</span><span className="account-change-value">{renderValue(c.field, c.to)}</span></div>
              </dd>
            </div>
          ))}
        </dl>
      ) : <p className="account-change-no-details">No field-level details recorded.</p>)}
    </details>
  );
}

/** Unmount on collapse so reopening checks current access and note content. */
function InternalNoteContent({ accountId, noteId }: { accountId: string; noteId: string }) {
  const note = useAsyncResource(async () => {
    const result = await communicationRequest<{ communication?: Communication | null }>("activity", { id: noteId, accountId });
    const communication = result.communication;
    if (!communication || communication.id !== noteId || communication.accountId !== accountId || communication.channel !== "NOTE") {
      throw new Error("Could not load this note.");
    }
    return typeof communication.text === "string" && communication.text.trim() ? communication.text : null;
  }, [accountId, noteId], { initialData: null, errorMessage: "Could not load this note.", clearDataOnError: isAuthorizationError });

  return (
    <div className="account-change-note">
      {!note.loaded || note.loading ? <p className="account-change-note-state" role="status">Loading note…</p>
        : note.error ? <div role="alert"><p className="account-change-note-state error-text">Could not load this note.</p><button className="secondary small" onClick={() => void note.refetch()}>Retry note</button></div>
          : note.data === null ? <div><p className="account-change-note-state">Note text is unavailable.</p><button className="secondary small" onClick={() => void note.refetch()}>Retry note</button></div>
            : <p className="account-change-note-text">{note.data}</p>}
    </div>
  );
}
