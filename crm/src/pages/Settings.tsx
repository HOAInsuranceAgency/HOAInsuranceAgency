import { useEffect, useState } from "react";
import { list, uploadData } from "aws-amplify/storage";
import { ACORD25_TEMPLATE_PATH, listTemplateFields } from "../lib/acord";

interface TemplateDef {
  path: string;
  label: string;
  note: string;
}

/** New ACORD forms later: add the template here + a mapping in lib/acord.ts. */
const TEMPLATES: TemplateDef[] = [
  {
    path: ACORD25_TEMPLATE_PATH,
    label: "ACORD 25 — Certificate of Liability Insurance",
    note: "Used by the Certificates tab on client accounts.",
  },
];

export default function Settings() {
  const [uploaded, setUploaded] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string[]>>({});
  const [error, setError] = useState("");

  useEffect(() => {
    list({ path: "templates/" }).then(({ items }) => {
      const present: Record<string, boolean> = {};
      for (const item of items) present[item.path] = true;
      setUploaded(present);
    });
  }, []);

  async function upload(tpl: TemplateDef, file: File | undefined) {
    if (!file) return;
    setBusy(tpl.path);
    setError("");
    try {
      await uploadData({
        path: tpl.path,
        data: file,
        options: { contentType: "application/pdf" },
      }).result;
      setUploaded((u) => ({ ...u, [tpl.path]: true }));
      setFields((f) => ({ ...f, [tpl.path]: [] }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(null);
    }
  }

  async function inspect(tpl: TemplateDef) {
    setBusy(tpl.path);
    setError("");
    try {
      const names = await listTemplateFields(tpl.path);
      setFields((f) => ({ ...f, [tpl.path]: names }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read template");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <h1>Settings</h1>
      <p className="sub">Form templates</p>

      <div className="card">
        <h2>ACORD templates</h2>
        <p className="muted small">
          ACORD forms are licensed, so the fillable PDFs are uploaded here
          rather than shipped with the app. After uploading, use{" "}
          <em>Inspect fields</em> to list the PDF's form-field names — if a
          generated certificate comes out with blanks, those names need to be
          added to the mapping in <code>src/lib/acord.ts</code>.
        </p>

        {TEMPLATES.map((tpl) => (
          <div key={tpl.path} style={{ marginTop: 14 }}>
            <h3 style={{ margin: "0 0 4px" }}>
              {tpl.label}{" "}
              {uploaded[tpl.path] ? (
                <span className="badge green">Uploaded</span>
              ) : (
                <span className="badge amber">Missing</span>
              )}
            </h3>
            <p className="muted small" style={{ margin: "0 0 8px" }}>
              {tpl.note}
            </p>
            <div className="toolbar">
              <input
                type="file"
                accept="application/pdf"
                disabled={busy === tpl.path}
                onChange={(e) => upload(tpl, e.target.files?.[0])}
              />
              {uploaded[tpl.path] && (
                <button
                  className="secondary"
                  disabled={busy === tpl.path}
                  onClick={() => inspect(tpl)}
                >
                  {busy === tpl.path ? "Reading…" : "Inspect fields"}
                </button>
              )}
            </div>
            {fields[tpl.path]?.length ? (
              <div className="ocr-text" style={{ maxHeight: 240 }}>
                {fields[tpl.path].join("\n")}
              </div>
            ) : null}
          </div>
        ))}
        {error && <p className="error-text">{error}</p>}
      </div>
    </>
  );
}
