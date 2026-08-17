import { useEffect, useRef, useState } from "react";

/**
 * A labelled value with a one-click copy.
 *
 * Built for the NPNs in the sidebar, which exist to be pasted into carrier
 * portals and state filings. The value stays selectable text as well as being
 * copyable, because that is the fallback when the clipboard API is not
 * available — `navigator.clipboard` needs a secure context, and while the app
 * is served over HTTPS, a plain-HTTP dev host or an older WebView is not.
 * Rather than pretend, the button says so and the digits are still there to
 * select by hand.
 */
export default function CopyValue({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  /** Extra class on the wrapper, for per-caller placement. */
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The confirmation is temporary, so it needs clearing — and the timer has to
  // die with the component or it sets state on something unmounted.
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    []
  );

  function flash(next: "copied" | "failed") {
    setState(next);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1800);
  }

  async function copy() {
    try {
      // Optional-chained: on an insecure origin `navigator.clipboard` is
      // undefined rather than throwing, which would otherwise be a TypeError
      // in the handler instead of a message the user can act on.
      await navigator.clipboard?.writeText(value);
      if (!navigator.clipboard) throw new Error("no clipboard");
      flash("copied");
    } catch {
      flash("failed");
    }
  }

  return (
    <div className={className ? `copy-value ${className}` : "copy-value"}>
      <span className="copy-value__label">{label}</span>
      <span className="copy-value__row">
        {/* Tabular figures so two NPNs of the same length line up. */}
        <span className="copy-value__num">{value}</span>
        <button
          type="button"
          className="copy-value__btn"
          onClick={copy}
          // The label names the field, because a sidebar with two of these
          // would otherwise offer two buttons called "Copy".
          aria-label={`Copy ${label}`}
        >
          {state === "copied" ? "Copied" : state === "failed" ? "Press ⌘C" : "Copy"}
        </button>
      </span>
    </div>
  );
}
