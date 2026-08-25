import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAsyncResource } from "../lib/useAsyncResource";
import { SaveStatus, useSaveStatus } from "./SaveStatus";
import { useSort, SortTh } from "../lib/useSort";
import {
  client,
  daysUntil,
  fmtDate,
  listAllPages,
  type MarketingTask,
  type Quote,
} from "../lib/client";
import {
  Badge,
  statusBadge,
  urgencyBadge,
  MARKETING_RESOLUTION_BADGE,
  MARKETING_SUBMIT_SCALE,
} from "../lib/badges";
import {
  MANUAL_TASK_RESOLUTIONS,
  type ManualTaskResolution,
} from "../lib/enums";

/**
 * Renewal marketing tasks — "submit this expiring risk to this carrier".
 *
 * Raised by the nightly renewal-tasks sweep. A task closes one of two ways: a
 * quote exists for that carrier (detected, never clicked), or a person closes
 * it and says why. The why is a resolution rather than a note because the
 * three reasons answer different questions later — two carriers that keep
 * coming back out of appetite is an appointment problem, and a run of
 * not-submitted-on-time is a staffing one.
 */

/** How close this task is to its submit-by. The 7/21 cutoffs and the wording
 *  live in `MARKETING_SUBMIT_SCALE` — see there for why they are tighter than
 *  the licence ladder's. */
const taskUrgency = (t: MarketingTask) =>
  urgencyBadge(daysUntil(t.submitBy), MARKETING_SUBMIT_SCALE);

/**
 * Close any open task whose carrier already has a quote on this account.
 *
 * The nightly job does this too, but a quote created at 10am shouldn't leave
 * a stale task sitting there until tomorrow's run.
 */
async function settleSatisfiedTasks(
  tasks: MarketingTask[],
  quotes: Quote[]
): Promise<MarketingTask[]> {
  const settled: MarketingTask[] = [];
  // Same UTC calendar the nightly sweep uses, so a task carrying neither
  // date falls back to the same day here as it does there. "" would make
  // every comparison below true and close tasks nothing had satisfied.
  const today = new Date().toISOString().slice(0, 10);
  for (const t of tasks) {
    if (t.status !== "OPEN") continue;
    const since = t.triggerDate ?? t.createdAt?.slice(0, 10) ?? today;
    const hit = quotes.some(
      (q) =>
        q.carrierId === t.carrierId &&
        q.accountId === t.accountId &&
        (q.createdAt ?? "").slice(0, 10) >= since
    );
    if (!hit) continue;
    const { data } = await client.models.MarketingTask.update({
      id: t.id,
      status: "COMPLETE",
      resolution: "QUOTED",
      completedAt: new Date().toISOString(),
      completedBy: "system (quote created)",
    });
    if (data) settled.push(data);
  }
  return settled;
}

/* ── The manual close, shared by both tables ─────────────────────────
   Both the per-account card and the agency-wide list close a task the same
   way, so the write lives here once. Amplify's `{ data, errors }` does not
   throw, and dropping `errors` would move a row on a write that never landed
   — these throw instead, which is what `saveStatus.run` reports on. */

async function writeClose(
  t: MarketingTask,
  resolution: ManualTaskResolution,
  completedByName: string
): Promise<MarketingTask> {
  const { data, errors } = await client.models.MarketingTask.update({
    id: t.id,
    status: "COMPLETE",
    resolution,
    completedAt: new Date().toISOString(),
    completedBy: completedByName,
  });
  if (errors?.length || !data) throw new Error(errors?.[0]?.message);
  return data;
}

async function writeReopen(t: MarketingTask): Promise<MarketingTask> {
  const { data, errors } = await client.models.MarketingTask.update({
    id: t.id,
    status: "OPEN",
    resolution: null,
    completedAt: null,
    completedBy: null,
  });
  if (errors?.length || !data) throw new Error(errors?.[0]?.message);
  return data;
}

/**
 * The reason is in the confirmation, not just "closed": the menu commits on
 * selection, so this line is where a mis-pick is caught.
 */
const closedMessage = (t: MarketingTask, resolution: ManualTaskResolution) =>
  `${t.carrierName ?? "Task"} closed — ${MARKETING_RESOLUTION_BADGE[
    resolution
  ].label.toLowerCase()}.`;

const reopenedMessage = (t: MarketingTask) =>
  `${t.carrierName ?? "Task"} reopened.`;

/**
 * Commit-on-selection close menu.
 *
 * No confirm step, because the outcome is named back in the status line and is
 * one click to undo. `label` is the accessible name and has to identify the
 * row: on the agency-wide list one carrier legitimately appears against many
 * accounts, so the carrier alone would leave several controls sharing a name.
 */
function CloseAsMenu({
  label,
  disabled,
  onPick,
}: {
  label: string;
  disabled: boolean;
  onPick: (resolution: ManualTaskResolution) => void;
}) {
  return (
    <select
      aria-label={label}
      value=""
      disabled={disabled}
      onChange={(e) => {
        const r = e.target.value as ManualTaskResolution | "";
        if (r) onPick(r);
      }}
    >
      <option value="">Close as…</option>
      {MANUAL_TASK_RESOLUTIONS.map((r) => (
        <option key={r} value={r}>
          {MARKETING_RESOLUTION_BADGE[r].label}
        </option>
      ))}
    </select>
  );
}

/** Marketing tasks for one account, shown under its quotes. */
export default function AccountMarketingTasks({
  accountId,
  completedByName,
}: {
  accountId: string;
  completedByName: string;
}) {
  const [showDone, setShowDone] = useState(false);
  // Which row's button is disabled — per-row, and `busy` from the hook can't
  // replace it: one panel-level flag would disable every row's button.
  const [busyId, setBusyId] = useState<string | null>(null);
  // Auto-clearing: both mutations move the row between the open and the
  // completed table, so the row the message names is no longer where the
  // user was looking and nothing else would ever retire it.
  const saveStatus = useSaveStatus({ autoClearMs: 4000 });
  // Which account the settle pass has already run for. This used to be a
  // boolean reset by the caller's own effect immediately before `load()`;
  // the hook owns that effect now, so the guard carries the identity it is
  // guarding instead of relying on two effects firing in declaration order.
  // Same semantics — once per account per mount — with no sibling to keep in
  // step, and a refetch of the same account still won't re-settle.
  const settledFor = useRef<string | null>(null);

  const taskRes = useAsyncResource(
    async () => {
      const [ts, qs] = await Promise.all([
        listAllPages((nextToken) =>
          client.models.MarketingTask.list({
            filter: { accountId: { eq: accountId } },
            limit: 500,
            nextToken,
          })
        ),
        listAllPages((nextToken) =>
          client.models.Quote.list({
            filter: { accountId: { eq: accountId } },
            limit: 500,
            nextToken,
          })
        ),
      ]);
      // list() yields a structurally looser type than the model type.
      let rows = ts as MarketingTask[];
      // Run the quote-satisfies-task check once per account, not on every
      // read — it writes, and re-running it would re-stamp completedAt.
      if (settledFor.current !== accountId) {
        settledFor.current = accountId;
        const settled = await settleSatisfiedTasks(rows, qs as Quote[]);
        if (settled.length) {
          const byId = new Map(settled.map((s) => [s.id, s]));
          rows = rows.map((t) => byId.get(t.id) ?? t);
        }
      }
      return rows;
    },
    [accountId],
    {
      initialData: [] as MarketingTask[],
      // The card hides itself when there are no tasks, so a swallowed
      // failure is indistinguishable from an account with none.
      errorMessage: "Failed to load marketing tasks",
    }
  );
  const tasks = taskRes.data;
  const setTasks = taskRes.setData;
  const { loaded, error } = taskRes;

  async function closeTask(t: MarketingTask, resolution: ManualTaskResolution) {
    setBusyId(t.id);
    await saveStatus.run(
      async () => {
        const data = await writeClose(t, resolution, completedByName);
        setTasks((ts) => ts.map((x) => (x.id === t.id ? data : x)));
      },
      {
        savedMessage: closedMessage(t, resolution),
        errorMessage: "Couldn't close that task.",
      }
    );
    setBusyId(null);
  }

  async function reopen(t: MarketingTask) {
    setBusyId(t.id);
    await saveStatus.run(
      async () => {
        const data = await writeReopen(t);
        setTasks((ts) => ts.map((x) => (x.id === t.id ? data : x)));
      },
      {
        savedMessage: reopenedMessage(t),
        errorMessage: "Couldn't reopen that task.",
      }
    );
    setBusyId(null);
  }

  const open = tasks.filter((t) => t.status === "OPEN");
  const done = tasks.filter((t) => t.status === "COMPLETE");

  // Soonest submit-by first; no submit-by date sorts last, which useSort
  // does for nulls in either direction.
  const { sorted, sortKey, dir, toggle } = useSort(
    open,
    {
      carrier: (t) => t.carrierName,
      lines: (t) => (t.lines ?? []).filter(Boolean).join(", "),
      expires: (t) => t.expirationDate,
      submitBy: (t) => t.submitBy,
    },
    "submitBy"
  );

  if (!loaded) return null;
  if (error)
    return (
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Marketing tasks</h2>
        <p className="error-text">Couldn't load marketing tasks: {error}</p>
      </div>
    );
  if (tasks.length === 0) return null;

  return (
    <div className="card">
      <div className="toolbar" style={{ marginTop: 0, alignItems: "flex-start" }}>
        <div>
          <h2 style={{ margin: 0 }}>Marketing tasks</h2>
          <p className="muted small" style={{ margin: "4px 0 0" }}>
            Carriers to submit this renewal to. A task closes on its own when a
            quote is created for that carrier — otherwise close it yourself and
            say why.
          </p>
        </div>
        <div className="grow" />
        {/* Closing and reopening are per-row actions with no per-row place to
            report; this is the card's one status line. */}
        <SaveStatus {...saveStatus.status} />
        {done.length > 0 && (
          <button className="link" onClick={() => setShowDone((v) => !v)}>
            {showDone ? "Hide" : `Show ${done.length} completed`}
          </button>
        )}
      </div>

      {open.length === 0 ? (
        <p className="muted small">All marketing tasks are complete.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <SortTh label="Carrier" colKey="carrier" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <SortTh label="Lines" colKey="lines" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <SortTh label="Expires" colKey="expires" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <SortTh label="Submit by" colKey="submitBy" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <th>Urgency</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((t) => {
                const u = taskUrgency(t);
                return (
                  <tr key={t.id}>
                    <td>
                      <strong>{t.carrierName ?? "—"}</strong>
                    </td>
                    <td className="small">
                      {(t.lines ?? []).filter(Boolean).join(", ") || "—"}
                    </td>
                    <td className="small">{fmtDate(t.expirationDate)}</td>
                    <td className="small">{fmtDate(t.submitBy)}</td>
                    <td>
                      <Badge {...u} />
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {/* Undo here is Reopen, in the completed table below. */}
                      <CloseAsMenu
                        label={`Close ${t.carrierName ?? "task"}`}
                        disabled={busyId === t.id}
                        onPick={(r) => void closeTask(t, r)}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showDone && done.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table>
            <tbody>
              {done.map((t) => (
                <tr key={t.id}>
                  <td>{t.carrierName ?? "—"}</td>
                  <td>
                    {/* A completed task with no resolution recorded reads as
                        out of carrier appetite. Those rows are historical:
                        back when they were closed that was the only thing a
                        manual close could mean, so the fallback still names
                        what actually happened. */}
                    <Badge
                      {...statusBadge(
                        MARKETING_RESOLUTION_BADGE,
                        t.resolution,
                        MARKETING_RESOLUTION_BADGE.OUT_OF_APPETITE
                      )}
                    />
                  </td>
                  <td className="small">
                    {t.completedAt ? fmtDate(t.completedAt.slice(0, 10)) : "—"}
                    {t.completedBy ? ` · ${t.completedBy}` : ""}
                  </td>
                  <td>
                    <button
                      className="link"
                      disabled={busyId === t.id}
                      onClick={() => reopen(t)}
                    >
                      Reopen
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Agency-wide open tasks — the dashboard tile drills through to this. */
export function AllMarketingTasks({
  completedByName,
}: {
  completedByName: string;
}) {
  const [query, setQuery] = useState("");
  // Per-row, for the same reason as the account card: one panel-level flag
  // would disable every row's menu at once.
  const [busyId, setBusyId] = useState<string | null>(null);
  /**
   * The row just closed, kept only so it can be put back.
   *
   * This screen reads open tasks only, so closing one makes its row vanish —
   * and unlike the account card there is no completed table here to reopen it
   * from. That is the whole justification for committing on selection, so
   * without an undo the menu would be a one-click write with no way back short
   * of finding the account.
   *
   * One level deep: closing a second row replaces the offer, which is why the
   * confirmation names the row it belongs to. The offer is rendered off the
   * back of the `saved` state, so it retires when that does rather than sitting
   * there over unrelated work.
   */
  const [undoTask, setUndoTask] = useState<MarketingTask | null>(null);
  // Longer than the account card's 4s: this one is an undo window, not just a
  // receipt. Auto-clearing at all is what stops a stale offer to undo a close
  // from several minutes ago.
  const saveStatus = useSaveStatus({ autoClearMs: 8000 });

  /**
   * `setLoaded(true)` used to be on the success path only, with no `.catch()`,
   * so a failed read left this screen on "Loading…" permanently. The hook sets
   * `loaded` in a `finally`, which is what makes the error branch below
   * reachable at all.
   */
  const res = useAsyncResource(
    async () =>
      (await listAllPages((nextToken) =>
        client.models.MarketingTask.list({
          filter: { status: { eq: "OPEN" } },
          limit: 500,
          nextToken,
        })
      )) as MarketingTask[],
    [],
    {
      initialData: [] as MarketingTask[],
      errorMessage: "Failed to load marketing tasks",
    }
  );
  const tasks = res.data;
  const setTasks = res.setData;
  const loaded = res.loaded;

  async function closeTask(t: MarketingTask, resolution: ManualTaskResolution) {
    setBusyId(t.id);
    await saveStatus.run(
      async () => {
        await writeClose(t, resolution, completedByName);
        // Drop the row rather than restyle it: this list is defined as the open
        // ones, and a closed row sitting in it is the thing the user came here
        // to get rid of. `t` is kept for the undo.
        setTasks((ts) => ts.filter((x) => x.id !== t.id));
        setUndoTask(t);
      },
      {
        savedMessage: closedMessage(t, resolution),
        errorMessage: "Couldn't close that task.",
      }
    );
    setBusyId(null);
  }

  async function undoClose(t: MarketingTask) {
    setBusyId(t.id);
    await saveStatus.run(
      async () => {
        const data = await writeReopen(t);
        // Straight back into the list; `useSort` puts it back in its place.
        setTasks((ts) => [...ts, data]);
        setUndoTask(null);
      },
      {
        savedMessage: reopenedMessage(t),
        errorMessage: "Couldn't reopen that task.",
      }
    );
    setBusyId(null);
  }

  const q = query.trim().toLowerCase();
  const filtered = q
    ? tasks.filter((t) =>
        [t.accountName, t.carrierName, (t.lines ?? []).filter(Boolean).join(" ")]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q))
      )
    : tasks;

  // Soonest submit-by first — the work that's most at risk floats up.
  const { sorted, sortKey, dir, toggle } = useSort(
    filtered,
    {
      account: (t) => t.accountName,
      carrier: (t) => t.carrierName,
      lines: (t) => (t.lines ?? []).filter(Boolean).join(", "),
      expires: (t) => t.expirationDate,
      submitBy: (t) => t.submitBy,
    },
    "submitBy"
  );

  return (
    <>
      <h1>Marketing tasks</h1>
      <p className="sub">
        Open carrier submissions for expiring policies and lead renewals
      </p>

      <div className="card">
        <div className="toolbar" style={{ marginTop: 0 }}>
          {/* Same shape as the Clients and Leads search: a `.field` wrapper
              is what carries the app's border, radius and focus ring, and
              the 360px cap keeps a search box from growing into a banner.
              This was a bare `.lic-search` input, which borrowed the
              licensing screen's sizing and nothing else — a browser-default
              box on a page of styled ones. */}
          <div className="field grow" style={{ maxWidth: 360 }}>
            <input
              placeholder="Search tasks by account, carrier, or line…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {q && (
            <>
              <span className="muted small">
                {filtered.length} of {tasks.length}
              </span>
              <button className="link" onClick={() => setQuery("")}>
                Clear
              </button>
            </>
          )}
          <div className="grow" />
          {/* Closing is a per-row action and the row is gone by the time it
              lands, so this is the only place it can be reported. */}
          <SaveStatus {...saveStatus.status} />
          {undoTask && saveStatus.status.state === "saved" && (
            <button
              className="link"
              disabled={busyId !== null}
              onClick={() => void undoClose(undoTask)}
            >
              Undo
            </button>
          )}
        </div>
        {!loaded ? (
          <p className="muted small">Loading…</p>
        ) : res.error ? (
          <p className="error-text">{res.error}</p>
        ) : sorted.length === 0 ? (
          <p className="muted small">
            {q
              ? "No tasks match that filter."
              : "No open marketing tasks. The nightly sweep raises them once a renewal enters its submission window."}
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <SortTh label="Account" colKey="account" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Carrier" colKey="carrier" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Lines" colKey="lines" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Expires" colKey="expires" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Submit by" colKey="submitBy" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <th>Urgency</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((t) => {
                  const u = taskUrgency(t);
                  return (
                    <tr key={t.id}>
                      <td>
                        <Link to={`/accounts/${t.accountId}?tab=quotes`}>
                          {t.accountName ?? "(account)"}
                        </Link>
                      </td>
                      <td>{t.carrierName ?? "—"}</td>
                      <td className="small">
                        {(t.lines ?? []).filter(Boolean).join(", ") || "—"}
                      </td>
                      <td className="small">{fmtDate(t.expirationDate)}</td>
                      <td className="small">{fmtDate(t.submitBy)}</td>
                      <td>
                        <Badge {...u} />
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {/* Named by account as well as carrier: one carrier
                            appears against many accounts here, so the carrier
                            alone would not say which row this closes. */}
                        <CloseAsMenu
                          label={`Close ${t.carrierName ?? "task"} for ${
                            t.accountName ?? "account"
                          }`}
                          disabled={busyId === t.id}
                          onPick={(r) => void closeTask(t, r)}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
