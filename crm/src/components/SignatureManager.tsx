import { useEffect, useRef, useState } from "react";
import { uploadData, getUrl, remove } from "../lib/scopedStorage";
import { client, friendlyError, type UserProfile } from "../lib/client";
import FileButton from "./FileButton";
import SignaturePad from "./SignaturePad";
import { SaveStatus, useSaveStatus } from "./SaveStatus";

/**
 * Manage one person's signature — draw it, or upload an image.
 *
 * Used two ways: compact inside the admin Team table (managing anyone), and
 * full-width on the self-service card (managing your own). Stored at
 * signatures/<profileId>.<ext>; one current signature per person.
 */
export default function SignatureManager(props: { profile: UserProfile | null; compact?: boolean; onChange: (p: UserProfile) => void }) {
  return <SignatureEditor key={props.profile?.id ?? "none"} {...props} />;
}

function SignatureEditor({
  profile,
  compact,
  onChange,
}: {
  profile: UserProfile | null;
  compact?: boolean;
  onChange: (p: UserProfile) => void;
}) {
  const [previewUrl, setPreviewUrl] = useState<{ key: string; url: string } | null>(null);
  const [revision, setRevision] = useState(0);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [busy, setBusy] = useState(false);
  const [drawing, setDrawing] = useState(false);
  // Persistent: the new signature is rendered right beside the confirmation,
  // so the message keeps describing what is on screen.
  const saveStatus = useSaveStatus();
  // `error` is now only the *read* failure from the getUrl below — a stored
  // signature that won't load is not a save outcome.
  const [error, setError] = useState("");

  const key = profile?.signatureKey ?? null;

  const url = previewUrl?.key === key ? previewUrl.url : null;
  useEffect(() => {
    let active = true;
    setPreviewUrl(null);
    setError("");
    if (key) getUrl({ path: key })
      .then(({ url }) => { if (active) setPreviewUrl({ key, url: url.toString() }); })
      .catch(err => { if (active) setError(friendlyError(err, "Couldn't load signature")); });
    return () => { active = false; };
  }, [key, revision]);

  if (!profile) return <span className="muted small">—</span>;

  async function store(data: Blob | File, ext: string, contentType: string) {
    if (!profile || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    await saveStatus.run(
      async () => {
        const path = `signatures/${profile.id}.${ext}`;
        await uploadData({ path, data, options: { contentType } }).result;
        // `errors` used to be dropped: the upload landed in S3 but the
        // profile row didn't point at it, and the panel said nothing at all.
        const { data: updated, errors } = await client.models.UserProfile.update({
          id: profile.id,
          signatureKey: path,
        });
        if (errors?.length || !updated) throw new Error(errors?.[0]?.message);
        if (!mounted.current) return;
        onChange(updated);
        // Replacing an image can retain its storage key; reload the preview.
        setRevision(value => value + 1);
        setDrawing(false);
      },
      { savedMessage: "Signature saved.", errorMessage: "Save failed" }
    );
    inFlight.current = false;
    if (mounted.current) setBusy(false);
  }

  async function uploadFile(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      saveStatus.markError(
        "Signature must be an image (transparent PNG works best)."
      );
      return;
    }
    const ext = file.name.split(".").pop()?.toLowerCase() || "png";
    await store(file, ext, file.type);
  }

  async function clear() {
    if (!profile || !key || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    await saveStatus.run(async () => {
      // Commit the profile first. A rejected update must leave its signature usable.
      const { data: updated, errors } = await client.models.UserProfile.update({ id: profile.id, signatureKey: null });
      if (errors?.length || !updated) throw new Error(errors?.[0]?.message || "Could not remove signature.");
      if (mounted.current) { onChange(updated); setPreviewUrl(null); }
      await remove({ path: key }).catch(() => undefined);
    }, { savedMessage: "Signature removed.", errorMessage: "Could not remove signature." });
    inFlight.current = false;
    if (mounted.current) setBusy(false);
  }

  const preview = url ? (
    <img
      src={url}
      alt="signature"
      style={{
        height: compact ? 26 : 54,
        maxWidth: compact ? 120 : 300,
        objectFit: "contain",
        background: "#fff",
        border: "1px solid var(--border)",
        borderRadius: 4,
        padding: 2,
      }}
    />
  ) : (
    <span className="muted small">{key ? "—" : "None on file"}</span>
  );

  if (drawing) {
    // A failed save leaves the pad open so the drawing isn't lost — which
    // means the status has to be reachable from in here, or the failure this
    // migration surfaces would be invisible on the draw path.
    return (
      <>
        <SaveStatus {...saveStatus.status} />
        <SignaturePad
          busy={busy}
          onCancel={() => setDrawing(false)}
          onSave={(png) => store(png, "png", "image/png")}
        />
      </>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
      }}
    >
      {preview}
      <button
        className="secondary"
        disabled={busy}
        onClick={() => setDrawing(true)}
      >
        {key ? "Draw new" : "Draw"}
      </button>
      <FileButton
        label={key ? "Upload new" : "Upload"}
        accept="image/*"
        busy={busy}
        onFiles={(files) => uploadFile(files?.[0])}
      />
      {key && (
        <button className="link" disabled={busy} onClick={clear}>
          Remove
        </button>
      )}
      <SaveStatus {...saveStatus.status} />
      {error && <span role="alert" className="error-text small">{error} <button className="link" disabled={busy} onClick={() => setRevision(value => value + 1)}>Retry signature</button></span>}
    </div>
  );
}
