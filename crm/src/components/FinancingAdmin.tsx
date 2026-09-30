import { useEffect, useId, useRef, useState } from "react";
import type { Schema } from "../../amplify/data/resource";
import { client, friendlyError } from "../lib/client";
import { Badge } from "../lib/badges";
import { defaultReviewBy, isOpinionCurrent } from "../lib/premiumFinance/gate";
import { PF_CONFIG_SHA256, PF_JURISDICTIONS } from "../lib/premiumFinance/jurisdictions";
import { useAsyncResource } from "../lib/useAsyncResource";
import { SaveStatus, useSaveStatus } from "./SaveStatus";

type Opinion = Schema["PfCounselOpinion"]["type"];
const CONDITIONAL = PF_JURISDICTIONS.filter(jurisdiction => jurisdiction.status === "conditional");

type OpinionPage = { items: Opinion[]; nextToken?: string };

async function loadOpinionHistory(nextToken?: string): Promise<OpinionPage> {
  // History includes states that no longer require an opinion under current rules.
  const page = await client.models.PfCounselOpinion.list({ limit: 100, nextToken });
  if (page.errors?.length) throw new Error(page.errors[0].message);
  if (!page.data) throw new Error("Couldn't load counsel opinions.");
  return { items: page.data, nextToken: page.nextToken ?? undefined };
}

/** Mounted only inside the administrator's disclosure on the Financing page. */
export function FinancingAdmin({ onChanged }: { onChanged: () => Promise<void> }) {
  const id = useId();
  const status = useSaveStatus();
  const [code, setCode] = useState("");
  const [effectiveAt, setEffectiveAt] = useState("");
  const [reviewBy, setReviewBy] = useState("");
  const [reviewByEdited, setReviewByEdited] = useState(false);
  const [notes, setNotes] = useState("");
  const generation = useRef(0), paging = useRef(false), seenTokens = useRef(new Set<string>());
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState("");
  const rows = useAsyncResource(() => loadOpinionHistory(), [], {
    initialData: { items: [] } as OpinionPage,
    errorMessage: "Couldn't load counsel opinions.",
  });
  const today = new Date().toISOString().slice(0, 10);
  const history = [...rows.data.items].sort((a, b) =>
    a.jurisdiction.localeCompare(b.jurisdiction) || b.effectiveAt.localeCompare(a.effectiveAt)
  );
  useEffect(() => () => { generation.current++; }, []);

  async function refreshHistory() {
    generation.current++;
    paging.current = false;
    seenTokens.current.clear();
    setLoadingMore(false);
    setPageError("");
    await rows.refetch();
  }

  async function loadMore() {
    const cursor = rows.data.nextToken;
    if (!cursor || rows.loading || paging.current || status.busy) return;
    const ticket = generation.current;
    paging.current = true;
    setLoadingMore(true);
    setPageError("");
    try {
      const page = await loadOpinionHistory(cursor);
      if (ticket !== generation.current) return;
      if (page.nextToken && (page.nextToken === cursor || seenTokens.current.has(page.nextToken))) {
        throw new Error("Couldn't finish loading counsel opinions. Retry history.");
      }
      seenTokens.current.add(cursor);
      rows.setData(previous => ({
        ...page,
        items: [...new Map([...previous.items, ...page.items].map(item => [item.id, item])).values()],
      }));
    } catch (error) {
      if (ticket === generation.current) setPageError(friendlyError(error, "Couldn't load more counsel opinions."));
    } finally {
      if (ticket === generation.current) {
        paging.current = false;
        setLoadingMore(false);
      }
    }
  }

  async function add() {
    if (!code || !effectiveAt || status.busy) return;
    await status.run(async () => {
      const { errors, data } = await client.models.PfCounselOpinion.create({
        jurisdiction: code,
        effectiveAt,
        reviewBy: reviewBy || defaultReviewBy(effectiveAt),
        notes: notes.trim() || null,
        occurredAt: new Date().toISOString(),
      });
      if (errors?.length) throw new Error(errors[0].message);
      if (!data) throw new Error("Couldn't confirm that the opinion was recorded. Refresh before trying again.");
      setCode("");
      setEffectiveAt("");
      setReviewBy("");
      setReviewByEdited(false);
      setNotes("");
      await refreshHistory();
      await onChanged();
    }, { savedMessage: "Opinion recorded.", errorMessage: "Couldn't record the opinion." });
  }

  return (
    <div className="financing-admin">
      <div className="card-head">
        <h2>Counsel opinions</h2>
        <SaveStatus {...status.status} />
      </div>
      <p className="muted small">Record a signed opinion to approve a conditional state through its review date.</p>
      {rows.loading && <p role="status" className="muted small">Loading opinion history…</p>}
      {(rows.error || pageError) && (
        <div className="inline-actions">
          <p role="alert" className="error-text">{rows.error || pageError}</p>
          <button type="button" className="secondary" disabled={rows.loading || status.busy} onClick={() => void refreshHistory()}>Retry history</button>
        </div>
      )}
      {!rows.loading && !rows.error && history.length === 0 && <p className="muted small">{rows.data.nextToken ? "More opinion history is available." : "No opinions recorded."}</p>}
      {history.length > 0 && (
        <div className="table-wrap" aria-busy={rows.loading || loadingMore}>
          <table aria-label="Counsel opinion history">
            <thead><tr><th>State</th><th>Effective</th><th>Review by</th><th>Status</th><th>Notes</th></tr></thead>
            <tbody>
              {history.map(opinion => (
                <tr key={opinion.id}>
                  <td>{PF_JURISDICTIONS.find(jurisdiction => jurisdiction.code === opinion.jurisdiction)?.name ?? opinion.jurisdiction}</td>
                  <td>{opinion.effectiveAt}</td>
                  <td>{opinion.reviewBy}</td>
                  <td>{isOpinionCurrent(opinion, today)
                    ? <Badge cls="green" label="Current" />
                    : <Badge cls="amber" label={opinion.effectiveAt > today ? "Upcoming" : "Past review"} />}</td>
                  <td className="small muted">{opinion.notes || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.data.nextToken && !rows.error && (
        <div className="inline-actions">
          <button type="button" className="secondary" disabled={rows.loading || loadingMore || status.busy} onClick={() => void loadMore()}>
            {loadingMore ? "Loading more history…" : "Load more history"}
          </button>
        </div>
      )}
      <form onSubmit={event => { event.preventDefault(); void add(); }}>
        <div className="form-grid">
          <div className="field">
            <label htmlFor={`${id}-state`}>State</label>
            <select id={`${id}-state`} value={code} disabled={status.busy} required onChange={event => { setCode(event.target.value); status.markDirty(); }}>
              <option value="">Choose state…</option>
              {CONDITIONAL.map(jurisdiction => <option key={jurisdiction.code} value={jurisdiction.code}>{jurisdiction.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${id}-effective`}>Effective date</label>
            <input id={`${id}-effective`} type="date" value={effectiveAt} disabled={status.busy} required onChange={event => {
              setEffectiveAt(event.target.value);
              if (!reviewByEdited) setReviewBy(event.target.value ? defaultReviewBy(event.target.value) : "");
              status.markDirty();
            }} />
          </div>
          <div className="field">
            <label htmlFor={`${id}-review`}>Review by</label>
            <input id={`${id}-review`} type="date" value={reviewBy} min={effectiveAt || undefined} disabled={status.busy} onChange={event => { setReviewBy(event.target.value); setReviewByEdited(Boolean(event.target.value)); status.markDirty(); }} />
          </div>
          <div className="field">
            <label htmlFor={`${id}-notes`}>Notes</label>
            <input id={`${id}-notes`} value={notes} disabled={status.busy} onChange={event => { setNotes(event.target.value); status.markDirty(); }} />
          </div>
        </div>
        <div className="inline-actions">
          <button type="submit" className="secondary" disabled={!code || !effectiveAt || status.busy}>Record opinion</button>
        </div>
      </form>

      <details className="financing-regulatory-reference">
        <summary>Regulatory reference</summary>
        <p className="muted small">Signed configuration SHA-256: <code style={{ overflowWrap: "anywhere" }}>{PF_CONFIG_SHA256}</code></p>
        <div className="table-wrap">
          <table aria-label="Financing regulatory reference">
            <thead><tr><th>State</th><th>Configured status</th><th className="num">Maximum APR</th><th className="num">Minimum financed</th><th>Note</th></tr></thead>
            <tbody>
              {PF_JURISDICTIONS.map(jurisdiction => (
                <tr key={jurisdiction.code}>
                  <td>{jurisdiction.name}</td>
                  <td>{jurisdiction.maxAprVerified === false ? "Blocked — ceiling unverified" : jurisdiction.status}</td>
                  <td className="num">{jurisdiction.maxApr === null ? "—" : `${jurisdiction.maxApr}%`}</td>
                  <td className="num">{jurisdiction.minPrincipal === null ? "—" : `$${jurisdiction.minPrincipal.toLocaleString("en-US")}`}</td>
                  <td className="small muted">{jurisdiction.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
