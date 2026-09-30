import { useEffect, useId, useRef, useState } from "react";
import { uploadData, getUrl, remove } from "../../lib/scopedStorage";
import {
  client,
  friendlyError,
  unwrap,
  type Account,
} from "../../lib/client";
import ConfirmButton from "../ConfirmButton";
import FilePreviewModal from "../FilePreview";
import "./PhotosCard.css";

const PHOTO_SLOTS = [
  { key: "coverPhotoKey", label: "Cover photo" },
  { key: "aerialPhotoKey", label: "Aerial photo" },
  { key: "plotPlanKey", label: "Plot plan" },
] as const;
type PhotoKey = (typeof PHOTO_SLOTS)[number]["key"];

export default function PhotosCard({
  account,
  onChange,
}: {
  account: Account;
  onChange: (a: Account) => void;
}) {
  const [operation, setOperation] = useState<{ slotKey: PhotoKey; kind: "upload" | "remove" } | null>(null);
  // The ref also guards two events received before React disables the controls.
  const operationBusy = useRef(false);
  const [preview, setPreview] = useState<{ s3Key: string; name: string } | null>(null);
  const [error, setError] = useState("");

  async function upload(slotKey: PhotoKey, file?: File) {
    if (!file || operationBusy.current) return;
    operationBusy.current = true;
    setOperation({ slotKey, kind: "upload" });
    setError("");
    try {
      // A replacement must not overwrite the prior object before its account
      // pointer is saved, including when both files have the same name.
      const path = `property-photos/${account.id}/${slotKey}-${crypto.randomUUID()}-${file.name}`;
      await uploadData({
        path,
        data: file,
        options: { contentType: file.type || undefined },
      }).result;
      const old = account[slotKey];
      const updated = unwrap(await client.models.Account.update({
        id: account.id,
        [slotKey]: path,
      }));
      if (old && old !== path) await remove({ path: old }).catch(() => {});
      onChange(updated);
    } catch (err) {
      // A failed response does not prove the account update failed. Keep the
      // uniquely named upload: the server may already have linked it before
      // the connection was lost, and deleting it would break that reference.
      setError(friendlyError(err, "Upload failed"));
    } finally {
      operationBusy.current = false;
      setOperation(null);
    }
  }

  async function clear(slotKey: PhotoKey) {
    if (operationBusy.current) return;
    operationBusy.current = true;
    setOperation({ slotKey, kind: "remove" });
    const old = account[slotKey];
    setError("");
    try {
      const updated = unwrap(await client.models.Account.update({
        id: account.id,
        [slotKey]: null,
      }));
      if (old) await remove({ path: old }).catch(() => {});
      onChange(updated);
    } finally {
      operationBusy.current = false;
      setOperation(null);
    }
  }

  return (
    <section className="card property-photos" aria-label="Site photos and plans">
      <div className="property-photos-heading">
        <h2>Site photos &amp; plans</h2>
        <span>Images or PDFs</span>
      </div>
      <div className="property-photos-grid">
        {PHOTO_SLOTS.map((slot) => (
          <PhotoSlot
            key={slot.key}
            label={slot.label}
            s3Key={account[slot.key] ?? null}
            busy={operation?.slotKey === slot.key && operation.kind === "upload"}
            disabled={operation !== null}
            onUpload={(f) => upload(slot.key, f)}
            onView={(s3Key) =>
              setPreview({ s3Key, name: `${slot.label}${s3Key.match(/\.[^./]+$/)?.[0] ?? ""}` })
            }
            onClear={() => clear(slot.key)}
            // <ConfirmButton> catches the rejection either way; without this
            // it would be dropped, and a confirm that silently does nothing
            // is worse than the unguarded button it replaced.
            onClearError={(err) => setError(friendlyError(err, "Remove failed"))}
          />
        ))}
      </div>
      {error && <p className="error-text property-photos-error" role="alert">{error}</p>}
      {preview && (
        <FilePreviewModal
          s3Key={preview.s3Key}
          name={preview.name}
          onClose={() => setPreview(null)}
        />
      )}
    </section>
  );
}

function PhotoSlot({
  label,
  s3Key,
  busy,
  disabled,
  onUpload,
  onView,
  onClear,
  onClearError,
}: {
  label: string;
  s3Key: string | null;
  busy: boolean;
  disabled: boolean;
  onUpload: (f?: File) => void;
  onView: (s3Key: string) => void;
  /** May be async — the confirm button stays busy until it settles. */
  onClear: () => void | Promise<unknown>;
  onClearError: (err: unknown) => void;
}) {
  const uploadId = useId();
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [thumbError, setThumbError] = useState(false);
  const isImage = s3Key
    ? /\.(png|jpe?g|gif|webp)$/i.test(s3Key)
    : false;

  useEffect(() => {
    let active = true;
    setThumbUrl(null);
    setThumbError(false);
    if (s3Key && isImage) {
      getUrl({ path: s3Key })
        .then(({ url }) => { if (active) setThumbUrl(url.toString()); })
        .catch(() => { if (active) setThumbError(true); });
    }
    return () => { active = false; };
  }, [s3Key, isImage]);

  return (
    <article className="property-photo-slot" aria-label={label}>
      <h3>{label}</h3>
      {s3Key ? (
        <button type="button" className="property-photo-preview" aria-label={`Preview ${label.toLowerCase()}`} onClick={() => onView(s3Key)}>
          {thumbUrl && !thumbError ? <img src={thumbUrl} alt="" onError={() => setThumbError(true)} /> : <span className="property-photo-placeholder">
            <PhotoIcon />
            <span>{thumbError ? "Preview unavailable" : isImage ? "Loading preview…" : "File attached"}</span>
          </span>}
          <span className="property-photo-preview-label">Preview</span>
        </button>
      ) : (
        <div className="property-photo-empty" role={busy ? "status" : undefined}>
          <PhotoIcon />
          <strong>{busy ? "Uploading…" : `No ${label.toLowerCase()}`}</strong>
          {!busy && <span>Upload an image or PDF</span>}
        </div>
      )}
      <div className="property-photo-actions">
        <label className={`property-photo-upload${disabled ? " is-busy" : ""}`} htmlFor={uploadId}>
          {busy ? "Uploading…" : s3Key ? "Replace" : "Upload"}<span className="property-photos-sr-only"> {label.toLowerCase()}</span>
          <input
            id={uploadId}
            type="file"
            accept="image/*,.pdf"
            disabled={disabled}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              onUpload(file);
            }}
          />
        </label>
        {s3Key && (
          /* Was unguarded: one click deleted the S3 object and nulled the
             field. */
          <fieldset className="property-photo-remove" disabled={disabled}>
          <ConfirmButton
            label="Remove"
            busyLabel="Removing…"
            message={`Remove the ${label.toLowerCase()}? The stored file is deleted.`}
            onConfirm={onClear}
            onError={onClearError}
          />
          </fieldset>
        )}
      </div>
    </article>
  );
}

function PhotoIcon() {
  return <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="3" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <path d="m3 17 5-5 4 4 3-3 6 6" />
  </svg>;
}
