import { useEffect, useRef, useState } from "react";
import { uploadData, getUrl, remove } from "aws-amplify/storage";
import { client, type CrmDocument } from "../lib/client";
import type { Schema } from "../../amplify/data/resource";

type EntityType = Schema["DocumentEntityType"]["type"];
type Category = NonNullable<Schema["DocumentCategory"]["type"]>;

const CATEGORIES: { value: Category; label: string }[] = [
  { value: "PRIOR_POLICY", label: "Prior policy packet" },
  { value: "CONDO_DOCS", label: "Condo documents" },
  { value: "BUDGET", label: "Budget" },
  { value: "DUES_SCHEDULE", label: "Dues per unit" },
  { value: "LOSS_RUNS", label: "Loss runs" },
  { value: "QUOTE_DOC", label: "Quote document" },
  { value: "POLICY_DOC", label: "Policy document" },
  { value: "LICENSE", label: "License" },
  { value: "OTHER", label: "Other" },
];

const OCR_BADGE: Record<string, { cls: string; label: string }> = {
  PENDING: { cls: "gray", label: "OCR queued" },
  PROCESSING: { cls: "amber", label: "OCR running" },
  COMPLETE: { cls: "green", label: "OCR done" },
  FAILED: { cls: "red", label: "OCR failed" },
  SKIPPED: { cls: "gray", label: "No OCR" },
};

/**
 * Attach-to-anything documents panel: uploads to
 * documents/{entityType}/{entityId}/{documentId}/{filename}, which the
 * Textract Lambda watches. observeQuery keeps OCR status live in the UI.
 */
export default function DocumentsPanel({
  entityType,
  entityId,
}: {
  entityType: EntityType;
  entityId: string;
}) {
  const [docs, setDocs] = useState<CrmDocument[]>([]);
  const [category, setCategory] = useState<Category>("OTHER");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [openDocId, setOpenDocId] = useState<string | null>(null);
  const [ocrSearch, setOcrSearch] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const sub = client.models.Document.observeQuery({
      filter: { entityId: { eq: entityId } },
    }).subscribe({
      next: ({ items }) =>
        setDocs(
          [...items].sort((a, b) =>
            (b.createdAt ?? "").localeCompare(a.createdAt ?? "")
          )
        ),
    });
    return () => sub.unsubscribe();
  }, [entityId]);

  async function handleUpload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setError("");
    try {
      for (const file of Array.from(files)) {
        const { data: doc, errors } = await client.models.Document.create({
          entityType,
          entityId,
          category,
          name: file.name,
          s3Key: "pending",
          contentType: file.type,
          sizeBytes: file.size,
          ocrStatus: "PENDING",
        });
        if (errors?.length || !doc) throw new Error(errors?.[0]?.message);

        const path = `documents/${entityType}/${entityId}/${doc.id}/${file.name}`;
        await client.models.Document.update({ id: doc.id, s3Key: path });
        await uploadData({
          path,
          data: file,
          options: { contentType: file.type || undefined },
        }).result;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function download(doc: CrmDocument) {
    const { url } = await getUrl({ path: doc.s3Key });
    window.open(url.toString(), "_blank");
  }

  async function deleteDoc(doc: CrmDocument) {
    if (!confirm(`Delete "${doc.name}"?`)) return;
    if (doc.s3Key && doc.s3Key !== "pending") {
      await remove({ path: doc.s3Key }).catch(() => {});
    }
    await client.models.Document.delete({ id: doc.id });
  }

  function highlight(text: string, term: string) {
    if (!term.trim()) return text;
    const parts = text.split(new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"));
    return parts.map((p, i) =>
      p.toLowerCase() === term.toLowerCase() ? <mark key={i}>{p}</mark> : p
    );
  }

  const openDoc = docs.find((d) => d.id === openDocId);

  return (
    <div>
      <div className="toolbar">
        <div className="field">
          <label>Category</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as Category)}
          >
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Attach files (PDF/images are OCR'd automatically)</label>
          <input
            ref={fileRef}
            type="file"
            multiple
            disabled={uploading}
            onChange={(e) => handleUpload(e.target.files)}
          />
        </div>
        {uploading && <span className="muted small">Uploading…</span>}
        {error && <span className="error-text">{error}</span>}
      </div>

      {docs.length === 0 ? (
        <p className="muted small">No documents attached.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Category</th>
                <th>OCR</th>
                <th>Size</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => {
                const badge = OCR_BADGE[d.ocrStatus ?? "PENDING"] ?? OCR_BADGE.PENDING;
                return (
                  <tr key={d.id}>
                    <td>{d.name}</td>
                    <td>
                      <span className="badge gray">
                        {CATEGORIES.find((c) => c.value === d.category)?.label ?? "—"}
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${badge.cls}`}>{badge.label}</span>
                      {d.ocrStatus === "FAILED" && d.ocrError && (
                        <div className="muted small">{d.ocrError}</div>
                      )}
                    </td>
                    <td className="muted small">
                      {d.sizeBytes ? `${Math.max(1, Math.round(d.sizeBytes / 1024))} KB` : "—"}
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <button className="link" onClick={() => download(d)}>
                        Download
                      </button>
                      {d.ocrStatus === "COMPLETE" && d.ocrText && (
                        <button
                          className="link"
                          onClick={() =>
                            setOpenDocId(openDocId === d.id ? null : d.id)
                          }
                        >
                          {openDocId === d.id ? "Hide text" : "View text"}
                        </button>
                      )}
                      <button className="danger" onClick={() => deleteDoc(d)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {openDoc?.ocrText && (
        <div style={{ marginTop: 14 }}>
          <h3>Extracted text — {openDoc.name}</h3>
          <div className="ocr-search field">
            <input
              placeholder="Find in text…"
              value={ocrSearch}
              onChange={(e) => setOcrSearch(e.target.value)}
            />
          </div>
          <div className="ocr-text">{highlight(openDoc.ocrText, ocrSearch)}</div>
        </div>
      )}
    </div>
  );
}
