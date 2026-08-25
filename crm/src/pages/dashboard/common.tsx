import { useEffect, useRef, useState, type ReactNode } from "react";

/** Today as YYYY-MM-DD in the local calendar — the same civil-day frame
 * `daysUntil` counts in, so string comparisons against `a.date()` fields
 * agree with the badges beside them. */
export function localToday(): string {
  return new Date().toLocaleDateString("en-CA");
}

/**
 * A KPI tile. With `onClick` it is the dashboard's clickable stat (keyboard
 * included); without, a plain figure — the leads tab has tiles with no list
 * page to land on, and a non-interactive div must not pretend otherwise.
 * `hot` paints the number red: the figure itself is the alarm (overdue
 * money, an attention count above zero).
 */
export function Tile({
  n,
  label,
  onClick,
  hot,
}: {
  n: ReactNode;
  label: string;
  onClick?: () => void;
  hot?: boolean;
}) {
  if (!onClick) {
    return (
      <div className={hot ? "stat hot" : "stat"}>
        <div className="n">{n}</div>
        <div className="l">{label}</div>
      </div>
    );
  }
  return (
    <div
      className={hot ? "stat clickable hot" : "stat clickable"}
      role="button"
      tabIndex={0}
      onClick={onClick}
      // Space as well as Enter: role="button" promises both, and a div gets
      // neither natively. preventDefault so Space doesn't also scroll.
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <div className="n">{n}</div>
      <div className="l">{label}</div>
    </div>
  );
}

interface TabResource {
  loading: boolean;
  loaded: boolean;
  error: string;
  refetch: () => Promise<void>;
}

/**
 * The loading/error/freshness frame every dashboard tab renders inside.
 *
 * One component rather than five copies of the gate, because the gate is
 * where the first draft got refresh wrong: `if (!loaded || error)` treats a
 * failed *refetch* like a failed first load, replacing a table of perfectly
 * good numbers with a bare error line — and unmounting the Refresh button
 * with it, so the one control that could recover is gone precisely when it's
 * needed. `useAsyncResource` keeps `data` through a failed refetch on
 * purpose; this frame honors that: before the first success it gates (with
 * a retry button, which the old error screen also lacked), after it the
 * content stays up and a failure is a line above it, not a replacement.
 *
 * "Has this tab ever had real numbers" is a ref, not hook state — `loaded`
 * can't answer it (it goes true when a failed first fetch settles too), and
 * it only ever flips false→true for the life of the mount.
 */
export function TabFrame({
  res,
  children,
}: {
  res: TabResource;
  children: ReactNode;
}) {
  const succeeded = useRef(false);
  // A settled, error-free fetch — not merely `loaded`, which is also true
  // while a retry after a failed first load is in flight (loaded stuck from
  // the failed settle, error just cleared). Latching there would render the
  // empty-state copy over data that never arrived, mid-retry.
  if (res.loaded && !res.loading && !res.error) succeeded.current = true;

  if (!succeeded.current) {
    if (res.error && !res.loading) {
      return (
        <>
          <p className="error-text">{res.error}</p>
          <button className="secondary" onClick={() => void res.refetch()}>
            Try again
          </button>
        </>
      );
    }
    return <p className="muted small">Loading…</p>;
  }

  return (
    <>
      <RefreshStamp res={res} />
      {res.error && (
        <p className="error-text">
          {res.error} — showing the last numbers that loaded.
        </p>
      )}
      {children}
    </>
  );
}

/**
 * "Updated 12:40 · Refresh" under the tab strip.
 *
 * Each dashboard tab owns one read and fetches on mount only, so the page
 * can sit open all morning showing breakfast's numbers. The stamp says how
 * stale, and the button re-runs the tab's read — the data survives the
 * refetch, so the tab greys rather than blanks. The stamp moves only on
 * *success*: after a failed refresh it keeps the last success's time, which
 * is the honest answer to "when are these numbers from". Wall-clock, set
 * when a fetch settles; it exists for a human judging freshness, not for
 * tests, which is why it isn't threaded through as a parameter the way
 * `leadStats` takes `now`.
 */
function RefreshStamp({ res }: { res: TabResource }) {
  const [stamp, setStamp] = useState<Date | null>(null);
  useEffect(() => {
    if (res.loaded && !res.loading && !res.error) setStamp(new Date());
  }, [res.loaded, res.loading, res.error]);

  return (
    <div className="tab-updated muted small">
      <span>
        {res.loading
          ? "Refreshing…"
          : stamp
            ? `Updated ${stamp.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
            : ""}
      </span>
      <button
        className="link"
        onClick={() => void res.refetch()}
        disabled={res.loading}
      >
        Refresh
      </button>
    </div>
  );
}
