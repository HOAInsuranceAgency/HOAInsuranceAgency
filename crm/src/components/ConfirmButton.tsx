import { useEffect, useId, useRef, useState } from "react";
import { friendlyError } from '../lib/client';

/**
 * A destructive button that arms itself instead of firing, replacing the
 * arm-then-confirm pair hand-rolled at four sites with three different label
 * sets. No `window.confirm` — the prompt stays inline, where the row is.
 *
 * Idle renders one trigger. Armed swaps it for confirm + cancel (plus an
 * optional message). Confirming awaits `onConfirm`: while it is in flight both
 * buttons are disabled and the confirm button reads `busyLabel`. On success it
 * disarms; on rejection it clears the busy state but stays armed, so the user
 * can retry or back out rather than being stuck.
 *
 * Default labels are Delete / Confirm / Cancel — the pair two of the four
 * sites already use, and the pair that reads correctly whatever the trigger
 * says. Every label is overridable.
 */

export interface ConfirmButtonProps {
  /**
   * The destructive action. May be async; the button stays busy until it
   * settles.
   */
  onConfirm: () => void | Promise<unknown>;
  /** Idle trigger label — also the armed group's accessible name. */
  label?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Shown on the confirm button while `onConfirm` is in flight. */
  busyLabel?: string;
  /** Optional explanation rendered next to the confirm button while armed. */
  message?: string;
  /** Disables the idle trigger. */
  disabled?: boolean;
  className?: string;
  confirmClassName?: string;
  cancelClassName?: string;
  /**
   * Called if `onConfirm` rejects. The rejection is caught either way — pass
   * this to surface it, or it is dropped.
   */
  onError?: (err: unknown) => void;
}

export default function ConfirmButton({
  onConfirm,
  label = "Delete",
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  busyLabel = "Deleting…",
  message,
  disabled = false,
  className = "danger",
  confirmClassName = "danger",
  cancelClassName = "link",
  onError,
}: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  const messageId = useId();

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Arming removes the button the user just pressed, so put focus somewhere
  // deliberate. Cancel, not confirm: a stray second Enter should back out of a
  // destructive action, not commit it.
  useEffect(() => {
    if (armed) cancelRef.current?.focus();
  }, [armed]);

  async function confirm() {
    if (pending.current || disabled) return;
    pending.current = true;
    setError('');
    setBusy(true);
    try {
      await onConfirm();
      if (alive.current) {
        setBusy(false);
        setArmed(false);
      }
    } catch (err) {
      if (alive.current) {
        setBusy(false);
        setError(friendlyError(err, 'Could not complete that action. Please try again.'));
        onError?.(err);
      }
    } finally {
      pending.current = false;
    }
  }

  return (
    <span
      className="confirm-button"
      role={armed ? "group" : undefined}
      aria-label={armed ? label : undefined}
    >
      {armed ? (
        <>
          {message ? (
            <span className="small" id={messageId}>
              {message}
            </span>
          ) : null}{" "}
          <button
            type="button"
            className={confirmClassName}
            disabled={busy || disabled}
            aria-describedby={message ? messageId : undefined}
            onClick={confirm}
          >
            {busy ? busyLabel : confirmLabel}
          </button>{" "}
          <button
            type="button"
            ref={cancelRef}
            className={cancelClassName}
            disabled={busy}
            onClick={() => { setArmed(false); setError(''); }}
          >
            {cancelLabel}
          </button>
        </>
      ) : (
        <button
          type="button"
          className={className}
          disabled={disabled}
          onClick={() => setArmed(true)}
        >
          {label}
        </button>
      )}
      {error && !onError && <span className="error-text" role="alert">{error}</span>}
    </span>
  );
}
