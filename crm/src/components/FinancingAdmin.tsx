import { useId, useState } from "react";
import type { Schema } from "../../amplify/data/resource";
import { client, listAllPages } from "../lib/client";
import { Badge } from "../lib/badges";
import { defaultReviewBy, isOpinionCurrent } from "../lib/premiumFinance/gate";
import { PF_CONFIG_SHA256, PF_JURISDICTIONS } from "../lib/premiumFinance/jurisdictions";
import { useAsyncResource } from "../lib/useAsyncResource";
import { SaveStatus, useSaveStatus } from "./SaveStatus";

type Opinion = Schema["PfCounselOpinion"]["type"];
const CONDITIONAL = PF_JURISDICTIONS.filter(jurisdiction => jurisdiction.status === "conditional");

async function loadOpinionHistory(): Promise<Opinion[]> {
  const histories = await Promise.all(CONDITIONAL.map(async jurisdiction => {
    const seenTokens = new Set<string>();
    return listAllPages(async nextToken => {
      const page = await client.models.PfCounselOpinion.listPfCounselOpinionByJurisdictionAndEffectiveAt(
        { jurisdiction: jurisdiction.code },
        { sortDirection: "DESC", limit: 100, nextToken }
      );
      if (page.errors?.length) throw new Error(page.errors[0].message);
      if (!page.data) throw new Error("Couldn't load counsel opinions.");
      if (page.nextToken && seenTokens.has(page.nextToken)) throw new Error("Couldn't finish loading counsel opinions. Try again.");
      if (page.nextToken) seenTokens.add(page.nextToken);
      return page;
    });
  }));
  return histories.flat().sort((a, b) =>
    a.jurisdiction.localeCompare(b.jurisdiction) || b.effectiveAt.localeCompare(a.effectiveAt)
  );
}

/** Mounted only inside the administrator's disclosure on the Financing page. */
export function FinancingAdmin({ onChanged }: { onChanged: () => Promise<void> }) {
  const id = useId();
  const status = useSaveStatus();
  const [code, setCode] = useState("");
  const [effectiveAt, setEffectiveAt] = useState("");
  const [reviewBy, setReviewBy] = useState("");
  const [notes, setNotes] = useState("");
  const rows = useAsyncResource(loadOpinionHistory, [], {
    initialData: [] as Opinion[],
    errorMessage: "Couldn't load counsel opinions.",
  });
  const today = new Date().toISOString().slice(0, 10);

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
      setNotes("");
      await rows.refetch();
      try {
        await onChanged();
      } catch {
        return "Opinion recorded. Refresh the page to update financing availability.";
      }
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
      {rows.error && (
        <div className="inline-actions">
          <p role="alert" className="error-text">{rows.error}</p>
          <button type="button" className="secondary" disabled={rows.loading} onClick={() => void rows.refetch()}>Retry history</button>
        </div>
      )}
      {!rows.loading && !rows.error && rows.data.length === 0 && <p className="muted small">No opinions recorded.</p>}
      {rows.data.length > 0 && (
        <div className="table-wrap" aria-busy={rows.loading}>
          <table aria-label="Counsel opinion history">
            <thead><tr><th>State</th><th>Effective</th><th>Review by</th><th>Status</th><th>Notes</th></tr></thead>
            <tbody>
              {rows.data.map(opinion => (
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
              if (event.target.value && !reviewBy) setReviewBy(defaultReviewBy(event.target.value));
              status.markDirty();
            }} />
          </div>
          <div className="field">
            <label htmlFor={`${id}-review`}>Review by</label>
            <input id={`${id}-review`} type="date" value={reviewBy} min={effectiveAt || undefined} disabled={status.busy} onChange={event => { setReviewBy(event.target.value); status.markDirty(); }} />
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
