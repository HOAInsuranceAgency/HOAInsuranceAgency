import { useCallback, useEffect, useRef, useState } from "react";
import { closeLeadUploads, uploadLeadFile } from "../lib/crmLead";
import {
  IDLE_AFTER_UPLOAD_MINUTES,
  MAX_FILES,
  REJECTION_MESSAGE,
  UPLOAD_ACCEPT,
  rejectUpload,
} from "../../../shared/leadUpload";
import "./LeadUploadPanel.css";

/**
 * Offer to take documents — *after* the lead is captured, never before.
 *
 * Uploading is the least likely thing a visitor will do, so it is not allowed
 * to cost a single submission. By the time this renders the lead is already in
 * the CRM and the agency has already been texted; everything here is upside.
 *
 * What the visitor is told matches what actually happens: their reply is held
 * while they send things, and goes as soon as they say they are done. That is
 * true — the deadline lives on the server and this component can only ever pull
 * it forward.
 */
export function LeadUploadPanel({
  uploadToken,
  onDone,
}: {
  uploadToken: string;
  /** Called once the window is closed, so the host can swap the panel out. */
  onDone?: () => void;
}) {
  type Row = {
    id: number;
    name: string;
    state: "uploading" | "done" | "failed";
    error?: string;
  };
  const [rows, setRows] = useState<Row[]>([]);
  const [closed, setClosed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const nextId = useRef(1);
  const inputRef = useRef<HTMLInputElement>(null);
  /**
   * Depth counter, not a boolean.
   *
   * `dragleave` fires every time the pointer crosses into a child element, so a
   * boolean flickers the whole zone off and on as you move across the file list.
   * Counting enters against leaves is the only thing that reads as steady.
   */
  const dragDepth = useRef(0);

  const uploaded = rows.filter((r) => r.state === "done").length;
  const busy = rows.some((r) => r.state === "uploading");

  /**
   * Tell the server when the page goes away, so a reply is not held for the
   * full window by someone who has already left.
   *
   * `pagehide`, not `visibilitychange`: the latter fires when they switch tabs
   * to find the file they were about to attach, which would close the window
   * mid-task. This is still best-effort — a lid closing fires nothing at all —
   * which is exactly why the server keeps its own deadline.
   */
  useEffect(() => {
    if (closed) return;
    const onHide = () => {
      // `keepalive` is what lets this outlive the page.
      void closeLeadUploads(uploadToken, { keepalive: true });
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [uploadToken, closed]);

  const finish = useCallback(async () => {
    setClosed(true);
    await closeLeadUploads(uploadToken);
    onDone?.();
  }, [uploadToken, onDone]);

  function onDragEnter(e: React.DragEvent) {
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }

  function onDragLeave(e: React.DragEvent) {
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }

  function onDrop(e: React.DragEvent) {
    // Without preventDefault the browser navigates to the dropped file, which
    // loses the confirmation screen and the upload window with it.
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const dropped = e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : null;
    void handleFiles(dropped);
  }

  async function handleFiles(files: File[] | null) {
    if (!files?.length) return;
    for (const file of files) {
      const rejection = rejectUpload({
        filename: file.name,
        sizeBytes: file.size,
        // Counted against what has landed, matching the server's own check.
        alreadyUploaded: rows.filter((r) => r.state !== "failed").length,
      });
      const id = nextId.current++;
      if (rejection) {
        setRows((rs) => [
          ...rs,
          { id, name: file.name, state: "failed", error: REJECTION_MESSAGE[rejection] },
        ]);
        continue;
      }
      setRows((rs) => [...rs, { id, name: file.name, state: "uploading" }]);
      try {
        await uploadLeadFile(uploadToken, file);
        setRows((rs) => rs.map((r) => (r.id === id ? { ...r, state: "done" } : r)));
      } catch (err) {
        setRows((rs) =>
          rs.map((r) =>
            r.id === id
              ? {
                  ...r,
                  state: "failed",
                  error: err instanceof Error ? err.message : "That upload failed.",
                }
              : r
          )
        );
      }
    }
  }

  if (closed) {
    return (
      <div className="lup lup--done">
        <p className="lup__done-text">
          {uploaded > 0
            ? `Thanks, ${uploaded} ${uploaded === 1 ? "file" : "files"} received. We're reading ${uploaded === 1 ? "it" : "them"} now and your summary is on its way.`
            : "No problem, your summary is on its way."}
        </p>
      </div>
    );
  }

  return (
    <div
      className={"lup" + (dragging ? " lup--dragging" : "")}
      onDragEnter={onDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <h3 className="lup__title">Have your current policy to hand?</h3>
      <p className="lup__sub">
        Send the declaration page, a recent budget, or your condo docs and we'll
        read them before we reply. Drag them in or choose them below. Optional:
        skip this and we'll still be in touch.
      </p>

      <label className="lup__pick">
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={UPLOAD_ACCEPT}
          disabled={uploaded >= MAX_FILES}
          onChange={(e) => {
            const picked = e.target.files ? Array.from(e.target.files) : null;
            // Reset before awaiting: the input's FileList is emptied in place
            // when value is cleared, so the array has to be taken first.
            e.target.value = "";
            void handleFiles(picked);
          }}
        />
        <span className="lup__pick-label">
          {rows.length ? "Add another file" : "Choose files"}
        </span>
      </label>

      {dragging && <p className="lup__drop-hint">Drop your files here</p>}

      {rows.length > 0 && (
        <ul className="lup__list">
          {rows.map((r) => (
            <li key={r.id} className={`lup__row lup__row--${r.state}`}>
              <span className="lup__name">{r.name}</span>
              <span className="lup__state">
                {r.state === "uploading" && "Sending…"}
                {r.state === "done" && "Received"}
                {r.state === "failed" && (r.error ?? "Failed")}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="lup__actions">
        <button
          type="button"
          className="lup__btn lup__btn--primary"
          disabled={busy}
          onClick={() => void finish()}
        >
          {uploaded > 0 ? "Done uploading" : "Skip, send my summary"}
        </button>
        {uploaded > 0 && (
          <p className="lup__note">
            We'll wait up to {IDLE_AFTER_UPLOAD_MINUTES} minutes for anything
            else, then send your summary.
          </p>
        )}
      </div>
    </div>
  );
}

export default LeadUploadPanel;
