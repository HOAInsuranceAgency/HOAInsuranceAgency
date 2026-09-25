import type { ChangeEvent } from "react";

/** Platform-styled file picker — hides the native input behind a button. */
export default function FileButton({
  label,
  multiple,
  accept,
  disabled,
  busy,
  onFiles,
}: {
  label: string;
  multiple?: boolean;
  accept?: string;
  disabled?: boolean;
  busy?: boolean;
  /**
   * Receives a plain array, deliberately — not the input's `FileList`.
   *
   * Resetting `value` below empties that FileList *in place*, so a handler
   * that read it any later than synchronously (say, from inside a React state
   * updater, which only runs eagerly on a component's first update) would see
   * zero files and silently drop the selection.
   */
  onFiles: (files: File[] | null) => void;
}) {
  function handle(e: ChangeEvent<HTMLInputElement>) {
    const files = e.target.files ? Array.from(e.target.files) : null;
    e.target.value = ""; // allow re-selecting the same file
    onFiles(files);
  }

  return (
    <label className={`file-btn${disabled || busy ? " disabled" : ""}`}>
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M12 16V4M6 10l6-6 6 6" />
        <path d="M4 20h16" />
      </svg>
      {busy ? "Uploading…" : label}
      <input
        type="file"
        multiple={multiple}
        accept={accept}
        disabled={disabled || busy}
        onChange={handle}
      />
    </label>
  );
}
