import { useState } from "react";
import { useIsAdmin } from "../lib/auth";
import { client, listAllPages } from "../lib/client";
import { PF_JURISDICTIONS } from "../lib/premiumFinance/jurisdictions";
import { hasCurrentOpinion, originationGate } from "../lib/premiumFinance/gate";
import { useAsyncResource } from "../lib/useAsyncResource";
import { FinancingAdmin } from "../components/FinancingAdmin";
import "./Financing.css";

type Opinion = { jurisdiction: string; effectiveAt: string; reviewBy: string };
type Availability = "available" | "unavailable" | "unknown";
type Filter = "all" | "available" | "unavailable";

/** State availability uses the same gate as origination. Deal-specific checks
 * still run on the invoice; legal notes and configuration belong to admins. */
export default function Financing() {
  const isAdmin = useIsAdmin();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [administrationOpen, setAdministrationOpen] = useState(false);
  const opinions = useAsyncResource(async () => {
    const pages = await Promise.all(PF_JURISDICTIONS.filter(j => j.status === "conditional").map(j => {
      const seen = new Set<string>();
      return listAllPages(async nextToken => {
        const page = await client.models.PfCounselOpinion.listPfCounselOpinionByJurisdictionAndEffectiveAt(
          { jurisdiction: j.code },
          { nextToken, limit: 100, selectionSet: ["id", "jurisdiction", "effectiveAt", "reviewBy"] },
        );
        if (page.errors?.length || !Array.isArray(page.data)) throw new Error("Couldn't check all states. Please try again.");
        if (page.nextToken) {
          if (seen.has(page.nextToken)) throw new Error("Couldn't finish checking all states. Please try again.");
          seen.add(page.nextToken);
        }
        return page;
      });
    }));
    return pages.flat();
  }, [], { initialData: [] as Opinion[], errorMessage: "Couldn't check all states. Please try again." });

  const today = new Date().toISOString().slice(0, 10);
  const rows = PF_JURISDICTIONS.map(j => {
    const pending = j.status === "conditional" && (opinions.loading || !opinions.loaded || !!opinions.error);
    const gate = originationGate(j.code, {
      hasCurrentCounselOpinion: !pending && hasCurrentOpinion(opinions.data.filter(o => o.jurisdiction === j.code), today),
    });
    const availability: Availability = pending ? "unknown" : gate.open ? "available" : "unavailable";
    return { ...j, availability, label: availability === "unknown" ? opinions.loading ? "Checking…" : "Retry check" : availability === "available" ? "Available" : "Unavailable" };
  });
  const query = search.trim().toLocaleLowerCase();
  const exactCode = rows.find(j => j.code.toLocaleLowerCase() === query)?.code;
  const visible = rows.filter(j =>
    (filter === "all" || j.availability === filter) &&
    (!query || (exactCode ? j.code === exactCode : j.name.toLocaleLowerCase().includes(query))),
  );
  const filters: { key: Filter; label: string; count: number }[] = [
    { key: "all", label: "All states", count: rows.length },
    { key: "available", label: "Available", count: rows.filter(j => j.availability === "available").length },
    { key: "unavailable", label: "Unavailable", count: rows.filter(j => j.availability === "unavailable").length },
  ];
  const reset = () => { setSearch(""); setFilter("all"); };

  return (
    <section className="financing-page">
      <header className="financing-page-header">
        <h1>Financing</h1>
        <p className="sub">Find out where we can finance commercial policies.</p>
      </header>
      <div className="card financing-lookup">
        <div className="financing-lookup-heading">
          <div><h2>Can we finance here?</h2><p>Check the property's state.</p></div>
          <button type="button" className="secondary" disabled={opinions.loading} onClick={() => void opinions.refetch()}>
            {opinions.loading ? "Checking…" : "Refresh availability"}
          </button>
        </div>
        <div className="financing-search">
          <label htmlFor="financing-state-search">Find a state</label>
          <div className="financing-search-input">
            <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
            <input id="financing-state-search" type="search" autoComplete="off" value={search} onChange={e => setSearch(e.target.value)} placeholder="State name or abbreviation" />
          </div>
        </div>
        <div className="financing-filter-bar">
          <div className="financing-filters" role="group" aria-label="Filter by availability">
            {filters.map(item => (
              <button key={item.key} type="button" aria-label={item.label} aria-pressed={filter === item.key} onClick={() => setFilter(item.key)}>
                {item.label} <span>{item.count}</span>
              </button>
            ))}
          </div>
          <span className="financing-result-count" role="status">{visible.length} {visible.length === 1 ? "result" : "results"}</span>
        </div>
        {opinions.error && <div className="financing-check-error" role="alert">A few states couldn't be checked. <button type="button" className="link" onClick={() => void opinions.refetch()}>Try again</button></div>}
        {visible.length ? (
          <ul className="financing-state-grid" aria-label="State availability">
            {visible.map(j => (
              <li key={j.code} className={`financing-state financing-state--${j.availability}`} aria-label={`${j.name}: ${j.label}`}>
                <span className="financing-state-code" aria-hidden="true">{j.code}</span>
                <div className="financing-state-name">
                  <strong>{j.name}</strong>
                  {j.availability === "available" && j.minPrincipal != null && <small>${j.minPrincipal.toLocaleString("en-US")}+ financed</small>}
                  {j.availability === "available" && j.requiresIncorporatedBorrower && <small>Incorporated associations</small>}
                </div>
                <span className="financing-state-status"><span aria-hidden="true">{j.availability === "available" ? "✓" : j.availability === "unavailable" ? "−" : "…"}</span>{j.label}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="financing-empty">
            <strong>{search.trim() ? `No states found for “${search.trim()}”` : "No states in this view"}</strong>
            <p>Try a state name or two-letter abbreviation.</p>
            <button type="button" className="secondary" onClick={reset}>Reset filters</button>
          </div>
        )}
      </div>
      <p className="financing-invoice-hint">Financing for a specific policy is confirmed on its invoice.</p>
      {isAdmin && (
        <details className="financing-administration" open={administrationOpen} onToggle={e => setAdministrationOpen(e.currentTarget.open)}>
          <summary>Administration</summary>
          {administrationOpen && <FinancingAdmin onChanged={opinions.refetch} />}
        </details>
      )}
    </section>
  );
}
