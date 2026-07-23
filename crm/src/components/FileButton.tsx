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
  onFiles: (files: FileList | null) => void;
}) {
  function handle(e: ChangeEvent<HTMLInputElement>) {
    onFiles(e.target.files);
    e.target.value = ""; // allow re-selecting the same file
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
