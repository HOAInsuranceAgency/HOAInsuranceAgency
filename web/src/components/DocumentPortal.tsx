import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchPortalStatus,
  uploadPortalFile,
  type PortalSection,
  type PortalStatus,
} from "../lib/uploadPortal";
import { MAX_FILE_BYTES, UPLOAD_ACCEPT, rejectUpload, REJECTION_MESSAGE } from "../../../shared/leadUpload";
import "./DocumentPortal.css";

/**
 * The page a lead reaches from the link in their auto-reply.
 *
 * One dropzone per thing we asked for, so a file arrives already filed as the
 * right category instead of as an untyped blob for someone to open and sort.
 * That is the whole reason this exists rather than one general dropzone.
 *
 * Nothing here is required and the page says so repeatedly. A board member who
 * reads a seven-item list as a precondition sends nothing for two months; one
 * who reads it as a menu sends the three things they can find today.
 */

type RowState = "uploading" | "done" | "failed";
interface Row {
  id: number;
  section: string;
  name: string;
  state: RowState;
  error?: string;
}

/** Per-tab, so a refresh survives the scrub below. Cleared when the tab closes. */
const TOKEN_KEY = "dp:token:v1";

/**
 * Read the link's token, take it out of the address bar, and remember it.
 *
 * A lazy `useState` initialiser rather than an effect, so the token is in hand on
 * the first render and the fetch starts immediately. The scrub happens here too:
 * doing it from a script on the page would race this component for the value.
 *
 * ## Why sessionStorage
 *
 * The scrub alone breaks refresh. Someone opens the link, the token comes out of
 * the URL, they hit reload — and the page tells them their link is missing its
 * code. People refresh pages, especially when an upload looks stuck, so that is
 * not a theoretical case. Stashing it per-tab means the URL stays clean AND
 * reload works, and it dies with the tab rather than persisting on the machine.
 *
 * `replaceState`, not `pushState` — a back button that restored the token would
 * put it straight back in the address bar.
 */
function takeToken(): string | null {
  if (typeof window === "undefined") return null;

  let fromUrl: string | null = null;
  try {
    const url = new URL(window.location.href);
    fromUrl = url.searchParams.get("t");
    if (fromUrl) {
      url.searchParams.delete("t");
      window.history.replaceState({}, "", url.pathname + url.search + url.hash);
    }
  } catch {
    // A malformed location is not worth failing over; fall through to the stash.
  }

  try {
    if (fromUrl) {
      // A fresh link wins over a remembered one: someone who was sent a new
      // token after the first expired must not keep using the dead one.
      window.sessionStorage.setItem(TOKEN_KEY, fromUrl);
      return fromUrl;
    }
    return window.sessionStorage.getItem(TOKEN_KEY);
  } catch {
    // Storage can throw in private modes. The URL token still works for this
    // load; only refresh is lost, which is where this started.
    return fromUrl;
  }
}

export function DocumentPortal({ token: given }: { token?: string | null } = {}) {
  // `given` exists so a test can drive this without a URL. In the page there is
  // no prop and the token comes off the location.
  const [token] = useState<string | null>(() => given ?? takeToken());
  const [status, setStatus] = useState<PortalStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [dragging, setDragging] = useState<string | null>(null);
  const nextId = useRef(1);
  /** Depth per section: `dragleave` fires on every child crossed. */
  const dragDepth = useRef(new Map<string, number>());

  useEffect(() => {
    if (!token) {
      setLoadError(
        "This link is missing its code. Open it straight from the email we sent."
      );
      return;
    }
    let live = true;
    fetchPortalStatus(token)
      .then((s) => live && setStatus(s))
      .catch((e: unknown) =>
        live &&
        setLoadError(e instanceof Error ? e.message : "We couldn't open that link.")
      );
    return () => {
      live = false;
    };
  }, [token]);

  const handleFiles = useCallback(
    async (sectionKey: string, files: File[] | null) => {
      if (!token || !files?.length) return;
      for (const file of files) {
        // The server checks all of this again; this is only so the visitor hears
        // about a 40MB video before waiting for the round trip.
        const rejection = rejectUpload({
          filename: file.name,
          sizeBytes: file.size,
          alreadyUploaded: 0,
        });
        const id = nextId.current++;
        if (rejection) {
          setRows((rs) => [
            ...rs,
            {
              id,
              section: sectionKey,
              name: file.name,
              state: "failed",
              error: REJECTION_MESSAGE[rejection],
            },
          ]);
          continue;
        }
        setRows((rs) => [
          ...rs,
          { id, section: sectionKey, name: file.name, state: "uploading" },
        ]);
        try {
          await uploadPortalFile(token, sectionKey, file);
          setRows((rs) =>
            rs.map((r) => (r.id === id ? { ...r, state: "done" } : r))
          );
          // Bump the section's own count, so the checklist reflects this file
          // without re-fetching the whole status.
          setStatus((s) =>
            s
              ? {
                  ...s,
                  uploadCount: s.uploadCount + 1,
                  sections: s.sections.map((sec) =>
                    sec.key === sectionKey
                      ? { ...sec, received: sec.received + 1 }
                      : sec
                  ),
                }
              : s
          );
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
    },
    [token]
  );

  if (loadError) {
    return (
      <div className="dp dp--error">
        <h1 className="dp__title">We couldn't open that link</h1>
        <p className="dp__lead">{loadError}</p>
        <p className="dp__lead">
          Replying to that email reaches us directly, and you can attach anything
          to the reply instead.
        </p>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="dp">
        <p className="dp__lead" role="status">
          Opening your document page…
        </p>
      </div>
    );
  }

  return (
    <div className="dp">
      <h1 className="dp__title">Documents for {status.associationName}</h1>
      <p className="dp__lead">
        Anything on this list helps us price your program accurately. None of it
        is required, and you don't have to do it in one sitting: this page keeps
        working, and it remembers what you've already sent.
      </p>

      {status.full && (
        <p className="dp__notice">
          This page has reached its {status.maxFiles}-file limit. Reply to the
          email it came from and we'll take the rest that way.
        </p>
      )}

      <ol className="dp__sections">
        {status.sections.map((section) => (
          <Section
            key={section.key}
            section={section}
            rows={rows.filter((r) => r.section === section.key)}
            disabled={status.full}
            dragging={dragging === section.key}
            onDragEnter={() => {
              const d = (dragDepth.current.get(section.key) ?? 0) + 1;
              dragDepth.current.set(section.key, d);
              setDragging(section.key);
            }}
            onDragLeave={() => {
              const d = Math.max(0, (dragDepth.current.get(section.key) ?? 0) - 1);
              dragDepth.current.set(section.key, d);
              if (d === 0) setDragging((cur) => (cur === section.key ? null : cur));
            }}
            onDrop={(files) => {
              dragDepth.current.set(section.key, 0);
              setDragging(null);
              void handleFiles(section.key, files);
            }}
            onPick={(files) => void handleFiles(section.key, files)}
          />
        ))}
      </ol>

      <p className="dp__foot">
        Files up to {Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB each. PDFs,
        photos and spreadsheets all work. If something won't go through, reply to
        our email and send it that way.
      </p>
    </div>
  );
}

function Section({
  section,
  rows,
  disabled,
  dragging,
  onDragEnter,
  onDragLeave,
  onDrop,
  onPick,
}: {
  section: PortalSection;
  rows: Row[];
  disabled: boolean;
  dragging: boolean;
  onDragEnter: () => void;
  onDragLeave: () => void;
  onDrop: (files: File[] | null) => void;
  onPick: (files: File[] | null) => void;
}) {
  const inputId = `dp-file-${section.key}`;
  return (
    <li
      className={"dp__section" + (dragging ? " dp__section--dragging" : "")}
      onDragEnter={(e) => {
        e.preventDefault();
        onDragEnter();
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => {
        e.preventDefault();
        onDragLeave();
      }}
      onDrop={(e) => {
        // Without preventDefault the browser navigates to the dropped file and
        // the page, along with everything already uploaded on it, is gone.
        e.preventDefault();
        onDrop(e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : null);
      }}
    >
      <div className="dp__head">
        <h2 className="dp__label">{section.label}</h2>
        {section.received > 0 && (
          <span className="dp__count">
            {section.received} received
          </span>
        )}
      </div>
      <p className="dp__help">{section.help}</p>

      <label className="dp__pick" htmlFor={inputId}>
        <input
          id={inputId}
          type="file"
          multiple
          accept={UPLOAD_ACCEPT}
          disabled={disabled}
          onChange={(e) => {
            const picked = e.target.files ? Array.from(e.target.files) : null;
            // Snapshot before the reset: the input's FileList is emptied in
            // place when value is cleared, so the array has to be taken first.
            e.target.value = "";
            onPick(picked);
          }}
        />
        <span>{section.received > 0 ? "Add another" : "Choose files"}</span>
      </label>

      {dragging && <p className="dp__drop-hint">Drop them here</p>}

      {rows.length > 0 && (
        <ul className="dp__files">
          {rows.map((r) => (
            <li key={r.id} className={`dp__file dp__file--${r.state}`}>
              <span className="dp__name">{r.name}</span>
              <span className="dp__state">
                {r.state === "uploading" && "Sending…"}
                {r.state === "done" && "Received"}
                {r.state === "failed" && (r.error ?? "Failed")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export default DocumentPortal;
