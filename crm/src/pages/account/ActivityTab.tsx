import { useMemo, useState } from "react";
import {
  client,
  fmtDateTime,
  fmtMoney,
  listAllPages,
  type Activity,
} from "../../lib/client";
import { useAsyncResource } from "../../lib/useAsyncResource";
import {
  fieldLabel,
  type FieldChange,
} from "../../../amplify/functions/activity-log/diff";

/**
 * Every change made to this account, newest first.
 *
 * Read-only by construction, not by convention: the `Activity` model grants a
 * signed-in user `read` and nothing else, and the rows are written by the
 * stream handler as an IAM principal. There is no "add" here because there is
 * no client path that could write one.
 *
 * ## What the timeline can and cannot tell you
 *
 * Capture is complete — a write that reached the table is a row here,
 * including one made by a Lambda, the backfill script, or somebody with the
 * console open. Attribution is not: it rides on `lastWriteBy`, which the
 * actor proxy stamps on creates and updates. A **delete** carries only an id,
 * so it has nowhere to put an actor and is recorded as System. That is stated
 * on the screen rather than left for someone to infer from a suspiciously
 * busy robot.
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
  if (Array.isArray(v)) return v.length ? v.join(", ") : "—";
  if (typeof v === "object") return "(changed)";
  if (typeof v === "number" && MONEY_FIELD.test(field)) return fmtMoney(v);
  return String(v);
}

export function ActivityTab({ accountId }: { accountId: string }) {
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
  const subjects = useMemo(
    () => [...new Set(rows.map((r) => r.subjectType))].sort(),
    [rows]
  );
  const actors = useMemo(
    () => [...new Set(rows.map((r) => r.actorName).filter(Boolean))].sort() as string[],
    [rows]
  );
  const filtered = rows.filter(
    (r) =>
      (!subjectFilter || r.subjectType === subjectFilter) &&
      (!actorFilter || r.actorName === actorFilter)
  );

  return (
    <div className="card">
      <h2>
        Activity{" "}
        {res.loaded && !res.error && (
          <span className="muted small" style={{ fontWeight: 400 }}>
            — {rows.length} change{rows.length === 1 ? "" : "s"}
          </span>
        )}
      </h2>
      <p className="muted small">
        Every write to this account and everything under it, captured from the
        database rather than from the screens. Deletions are recorded as
        System: a delete carries only an id, so there is nothing on it to say
        who pressed the button.
      </p>

      {!res.loaded ? (
        <p className="muted small">Loading…</p>
      ) : res.error ? (
        <p className="error-text">{res.error}</p>
      ) : rows.length === 0 ? (
        <p className="muted small">
          Nothing recorded yet. Changes made from here on will appear.
        </p>
      ) : (
        <>
          <div className="toolbar">
            <div className="field">
              <label>Subject</label>
              <select
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
              <label>Who</label>
              <select
                value={actorFilter}
                onChange={(e) => setActorFilter(e.target.value)}
              >
                <option value="">Anyone</option>
                {actors.map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
            </div>
          </div>

          {filtered.length === 0 ? (
            <p className="muted small">Nothing matches those filters.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Who</th>
                    <th>What</th>
                    <th>Change</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => {
                    const changes = readChanges(r.changes);
                    return (
                      <tr key={r.id}>
                        <td style={{ whiteSpace: "nowrap" }}>
                          {fmtDateTime(r.occurredAt)}
                        </td>
                        <td>{r.actorName ?? "System"}</td>
                        <td>
                          <span className="badge gray">{r.action}</span>{" "}
                          {[r.subjectType, r.subjectLabel].filter(Boolean).join(" ")}
                        </td>
                        <td className="small">
                          {r.summary}
                          {/* The sentence is the row; the field list is the
                              detail behind it, and only worth showing when it
                              says more than the sentence already did. */}
                          {changes.length > 2 && (
                            <ul style={{ margin: "4px 0 0", paddingLeft: 16 }}>
                              {changes.map((c: FieldChange) => (
                                <li key={c.field} className="muted">
                                  {fieldLabel(c.field)}: {renderValue(c.field, c.from)}{" "}
                                  → {renderValue(c.field, c.to)}
                                </li>
                              ))}
                            </ul>
                          )}
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
    </div>
  );
}
