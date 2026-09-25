import { Pagination } from "../components/ui/kit";
import { useListPage } from "../lib/useListPage";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  client,
  fmtDate,
  friendlyError,
  listAllPages,
  type CrmDocument,
} from "../lib/client";
import { downloadFile } from "../lib/storage";
import FilePreviewModal, { canPreview } from "../components/FilePreview";
import { useAsyncResource } from "../lib/useAsyncResource";
import { useSort, SortTh } from "../lib/useSort";
import {
  HIT_TYPE_LABEL,
  MIN_QUERY_LENGTH,
  ocrSnippet,
  searchRows,
} from "../lib/universalSearch";
import { fetchSearchIndexRows } from "../lib/searchIndexData";

// Stable identity for "no search run yet", so the sort memo isn't rebuilt
// on every render before the first result.
const NO_RESULTS: CrmDocument[] = [];

/**
 * The full results page behind the top bar — Enter with nothing selected
 * lands here. A-tier hits render as grouped quick links from the same index
 * the bar uses; documents keep everything the old /documents page offered:
 * the OCR snippet, preview, download, and the entity link. The query lives
 * in ?q=, so a result set is a URL someone can send.
 */
export default function SearchResults() {
  const [searchParams] = useSearchParams();
  const [category, setCategory] = useState("");
  const q = (searchParams.get("q") ?? "").trim();
  const runnable = q.length >= MIN_QUERY_LENGTH;

  const [previewDoc, setPreviewDoc] = useState<CrmDocument | null>(null);
  // Separate from the search error — a failed download shouldn't read as a
  // failed search, and shouldn't be wiped out by the next one either.
  const [downloadError, setDownloadError] = useState("");

  const index = useAsyncResource(fetchSearchIndexRows, [], {
    initialData: [],
    errorMessage: "Couldn't load records to search",
  });
  const groups = useMemo(
    () => (runnable ? searchRows(index.data, q, 50) : []),
    [index.data, q, runnable]
  );

  // Full document rows — ocrText included, because the snippet, preview and
  // download below need them. Same query and page cap the old page ran.
  const docs = useAsyncResource(
    () =>
      runnable
        ? listAllPages(
            (nextToken) =>
              client.models.Document.list({
                filter: {
                  or: [{ name: { contains: q } }, { ocrText: { contains: q } }],
                },
                nextToken,
              }),
            { maxPages: 25 }
          )
        : Promise.resolve(NO_RESULTS),
    [q],
    { initialData: NO_RESULTS, errorMessage: "Document search failed" }
  );

  // Most recently uploaded first, as the old page ordered the hits.
  const { sorted, sortKey, dir, toggle } = useSort(
    docs.data.filter(d => !category || d.category === category),
    {
      document: (d) => d.name,
      attached: (d) => d.entityType,
      uploaded: (d) => d.createdAt,
    },
    "uploaded",
    "desc"
  );

  const page = useListPage(sorted, `${q}:${category}:${sortKey}:${dir}`);

  async function download(doc: CrmDocument) {
    setDownloadError("");
    try {
      await downloadFile(doc.s3Key, { filename: doc.name });
    } catch (err) {
      setDownloadError(
        `"${doc.name}" couldn't be downloaded — ${friendlyError(err, "unknown error")}`
      );
    }
  }

  function entityLink(doc: CrmDocument) {
    if (doc.entityType === "ACCOUNT")
      return <Link to={`/accounts/${doc.entityId}`}>View account</Link>;
    if (doc.entityType === "CARRIER")
      return <Link to={`/carriers/${doc.entityId}`}>View carrier</Link>;
    return <span className="badge gray">{doc.entityType}</span>;
  }

  return (
    <>
      <h1>Search</h1>
      <p className="sub">
        {runnable
          ? `Records and document text matching “${q}”`
          : "Type in the search bar above — two characters minimum"}
      </p>

      {runnable && (
        <>
          {index.error && <p className="error-text">{index.error}</p>}
          {index.loading && !index.loaded && (
            <p className="muted small">Searching records…</p>
          )}
          {index.loaded && !index.error && groups.length === 0 && (
            <p className="muted small">No accounts, contacts, or paper match.</p>
          )}
          {groups.map((g) => (
            <div className="card" key={g.type}>
              <h2>
                {HIT_TYPE_LABEL[g.type]}
                {g.more > 0 && (
                  <span className="muted small"> · first 50 of {g.hits.length + g.more}</span>
                )}
              </h2>
              <div className="table-wrap">
                <table className="stacked-table">
                  <tbody>
                    {g.hits.map((h) => (
                      <tr key={h.id}>
                        <td>
                          <Link to={h.target}>{h.label}</Link>
                        </td>
                        <td className="small muted">{h.sub}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          {downloadError && <p className="error-text">{downloadError}</p>}
          <div className="card">
            <h2>Documents</h2>
            <label className="field">Category<select value={category} onChange={e => setCategory(e.target.value)}><option value="">All categories</option>{[...new Set(docs.data.map(d => d.category).filter(Boolean))].sort().map(c => <option key={c} value={c!}>{c}</option>)}</select></label>
            {!docs.loaded ? (
              <p className="muted small">Searching document text…</p>
            ) : docs.error ? (
              <p className="error-text">{docs.error}</p>
            ) : sorted.length === 0 ? (
              <p className="muted small">No documents match “{q}”.</p>
            ) : (
              <div className="table-wrap">
                <table className="stacked-table">
                  <thead>
                    <tr>
                      <SortTh label="Document" colKey="document" sortKey={sortKey} dir={dir} onToggle={toggle} />
                      <th>Match</th>
                      <SortTh label="Attached to" colKey="attached" sortKey={sortKey} dir={dir} onToggle={toggle} />
                      <SortTh label="Uploaded" colKey="uploaded" sortKey={sortKey} dir={dir} onToggle={toggle} />
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.rows.map((d) => (
                      <tr key={d.id}>
                        <td data-label="Document">
                          <strong>{d.name}</strong>
                          {d.category && (
                            <div>
                              <span className="badge gray">{d.category}</span>
                            </div>
                          )}
                        </td>
                        <td className="small muted" style={{ maxWidth: 380 }} data-label="Match">
                          {ocrSnippet(d.ocrText, q) ?? "matched file name"}
                        </td>
                        <td data-label="Attached to">{entityLink(d)}</td>
                        <td className="small" data-label="Uploaded">{fmtDate(d.createdAt?.slice(0, 10))}</td>
                        <td style={{ whiteSpace: "nowrap" }} data-label="Actions">
                          {canPreview(d.name) && (
                            <button className="link" onClick={() => setPreviewDoc(d)}>
                              Preview
                            </button>
                          )}
                          <button className="link" onClick={() => download(d)}>
                            Download
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
      {runnable && docs.loaded && !docs.error && <Pagination total={sorted.length} page={page.page} onPage={page.setPage} noun="documents" />}
      {previewDoc && (
        <FilePreviewModal
          s3Key={previewDoc.s3Key}
          name={previewDoc.name}
          onClose={() => setPreviewDoc(null)}
        />
      )}
    </>
  );
}
