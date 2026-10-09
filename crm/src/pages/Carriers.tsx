import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  client,
  assertNoErrors,
  fmtMoney,
  listAllPages,
  US_STATES,
  type AppetiteGuide,
  type Carrier,
} from "../lib/client";
import { Badge, flagBadge, CARRIER_APPOINTMENT_BADGE } from "../lib/badges";
import {
  MARKET_TYPE_LABELS,
  MARKET_TYPE_OPTIONS,
  PAPER_TYPE_LABELS,
  PAPER_TYPE_OPTIONS,
  type PaperType,
} from "../lib/enums";
import {
  guideFits,
  LOSS_LOOKBACK_YEARS,
  restrictionSummary,
  type AppetiteRisk,
} from "../lib/appetite";
import { useSort, SortTh } from "../lib/useSort";
import { useFormState } from "../lib/useFormState";
import { SaveStatus, useSaveStatus } from "../components/SaveStatus";
import { useAsyncResource } from "../lib/useAsyncResource";
import "./Carriers.css";

function recordedStates(carrier: Carrier) {
  return [...new Set((carrier.states ?? []).filter((state): state is string => Boolean(state)))];
}

function CarrierSortTh({ label, colKey, sortKey, dir, onToggle }: Parameters<typeof SortTh>[0]) {
  const active = colKey === sortKey;
  return <th aria-sort={active ? dir === "asc" ? "ascending" : "descending" : "none"}>
    <button className="carrier-sort" onClick={() => onToggle(colKey)}>
      {label}<span className="arrow" aria-hidden="true">{active ? dir === "asc" ? " ▲" : " ▼" : ""}</span>
    </button>
  </th>;
}

export default function Carriers() {
  const [showForm, setShowForm] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [coverageState, setCoverageState] = useState("");
  const [marketType, setMarketType] = useState("");
  const [finderReady, setFinderReady] = useState(false);
  const creating = useRef(false);
  // Persistent: a successful create navigates away, so what this is really
  // for is the failure that used to be swallowed entirely.
  const saveStatus = useSaveStatus();
  const { form, setF } = useFormState(
    { name: "", appointed: true },
    { onEdit: saveStatus.markDirty }
  );
  const navigate = useNavigate();

  const carrierRes = useAsyncResource(
    () => listAllPages(async (nextToken) => {
      const page = await client.models.Carrier.list({ nextToken });
      assertNoErrors(page);
      return page;
    }),
    [],
    { initialData: [] as Carrier[], errorMessage: "Failed to load carriers" }
  );
  const carriers = carrierRes.data;

  // Surfaced, not ignored: the guides drive the appetite finder's verdict and
  // the "Lines written" column. Without them the finder answers "no appetite"
  // for every risk, which is a wrong answer rather than a missing one.
  const guideRes = useAsyncResource(
    () => listAllPages(async (nextToken) => {
      const page = await client.models.AppetiteGuide.list({ nextToken });
      assertNoErrors(page);
      return page;
    }),
    [],
    { initialData: [] as AppetiteGuide[], errorMessage: "Failed to load appetite guides" }
  );
  const guides = guideRes.data;

  // Keep the finder mounted after its first successful read so refreshes and
  // retries retain risk answers. Cached data must not produce a fresh verdict.
  const appetiteAvailable = carrierRes.loaded && guideRes.loaded
    && !carrierRes.loading && !guideRes.loading && !carrierRes.error && !guideRes.error;
  useEffect(() => {
    if (appetiteAvailable) setFinderReady(true);
  }, [appetiteAvailable]);

  const query = search.trim().toLocaleLowerCase();
  const filtered = carriers.filter((carrier) =>
    (!query || [carrier.name, carrier.primaryUnderwriterName].some((value) => value?.toLocaleLowerCase().includes(query)))
    && (statusFilter === "all" || Boolean(carrier.appointed) === (statusFilter === "appointed"))
    && (!coverageState || recordedStates(carrier).includes(coverageState))
    && (!marketType || carrier.marketType === marketType)
  );
  const appointedCount = carriers.filter((carrier) => carrier.appointed).length;
  const filtersActive = Boolean(query || statusFilter !== "all" || coverageState || marketType);
  const guidesAvailable = guideRes.loaded && !guideRes.loading && !guideRes.error;

  function clearFilters() {
    setSearch("");
    setStatusFilter("all");
    setCoverageState("");
    setMarketType("");
  }

  const { sorted, sortKey, dir, toggle } = useSort(
    filtered,
    {
      name: (c) => c.name,
      status: (c) => (c.appointed ? "Appointed" : "Prospective"),
      underwriter: (c) => c.primaryUnderwriterName,
      market: (c) => (c.marketType ? MARKET_TYPE_LABELS[c.marketType] : null),
      commission: (c) => c.standardCommissionPct,
      states: (c) => recordedStates(c).length || null,
    },
    "name"
  );

  async function create() {
    if (creating.current || !form.name.trim()) return;
    creating.current = true;
    try {
      await saveStatus.run(
        async () => {
          const { data, errors } = await client.models.Carrier.create({
            name: form.name.trim(),
            appointed: form.appointed,
          });
          if (errors?.length || !data) throw new Error(errors?.[0]?.message);
          navigate(`/carriers/${data.id}`);
        },
        { errorMessage: "Couldn't create that carrier." }
      );
    } finally {
      creating.current = false;
    }
  }

  return (
    <div className="carriers-page">
      <header className="carriers-header">
        <div>
          <h1>Carriers</h1>
          <p className="sub">Manage your markets and find the right fit for a risk.</p>
        </div>
        <div className="carriers-header-actions">
          <button className="secondary" disabled={carrierRes.loading || guideRes.loading} onClick={() => {
            void carrierRes.refetch();
            void guideRes.refetch();
          }}>Refresh</button>
          <button className="primary" disabled={saveStatus.busy} onClick={() => setShowForm(!showForm)} aria-expanded={showForm} aria-controls="add-carrier-form">
            {showForm ? "Cancel" : "+ Add carrier"}
          </button>
        </div>
      </header>

      {showForm && (
        <form id="add-carrier-form" aria-label="Add carrier" className="card carrier-create" onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <h2>Add carrier</h2>
          <fieldset disabled={saveStatus.busy} className="carrier-create-fields">
            <div className="field">
              <label htmlFor="new-carrier-name">Carrier name *</label>
              <input id="new-carrier-name" required autoFocus value={form.name} onChange={(e) => setF("name", e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="new-carrier-status">Status</label>
              <select
                id="new-carrier-status"
                value={form.appointed ? "1" : "0"}
                onChange={(e) => setF("appointed", e.target.value === "1")}
              >
                <option value="1">Appointed</option>
                <option value="0">Prospective</option>
              </select>
            </div>
            <button
              type="submit"
              className="primary"
              disabled={saveStatus.busy || !form.name.trim()}
            >
              {saveStatus.busy ? "Creating…" : "Create carrier"}
            </button>
          </fieldset>
          <div className="carrier-save-status">
            <SaveStatus {...saveStatus.status} />
          </div>
        </form>
      )}

      {/* Only complete, successful reads can support an appetite verdict. */}
      {finderReady && (
        <AppetiteFinder carriers={carriers} guides={guides} available={appetiteAvailable} />
      )}
      {guideRes.error && <p className="error-text" role="alert">{guideRes.error} <button className="secondary" disabled={guideRes.loading} onClick={() => void guideRes.refetch()}>Retry appetite guides</button></p>}

      <section className="card carrier-directory" aria-labelledby="carrier-directory-title">
        <div className="carrier-directory-head">
          <div>
            <h2 id="carrier-directory-title">Carrier directory</h2>
            {carrierRes.loaded && !carrierRes.error && <p className="muted small">{appointedCount} appointed · {carriers.length - appointedCount} prospective</p>}
          </div>
          <div className="field carrier-search">
            <label htmlFor="carrier-search">Search carriers</label>
            <input id="carrier-search" type="search" placeholder="Carrier or underwriter" value={search} onChange={(event) => setSearch(event.target.value)} />
          </div>
        </div>
        <div className="carrier-directory-filters">
          <div className="carrier-status-filter" role="group" aria-label="Appointment status">
            {[
              ["all", `All (${carriers.length})`],
              ["appointed", `Appointed (${appointedCount})`],
              ["prospective", `Prospective (${carriers.length - appointedCount})`],
            ].map(([value, label]) => <button key={value} aria-pressed={statusFilter === value} onClick={() => setStatusFilter(value)}>{label}</button>)}
          </div>
          <div className="carrier-coverage-filters">
            <div className="field">
              <label htmlFor="carrier-coverage-state">Coverage state</label>
              <select id="carrier-coverage-state" value={coverageState} onChange={(event) => setCoverageState(event.target.value)}>
                <option value="">All states</option>
                {US_STATES.map((state) => <option key={state}>{state}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="carrier-market-type">Market type</label>
              <select id="carrier-market-type" value={marketType} onChange={(event) => setMarketType(event.target.value)}>
                <option value="">All markets</option>
                {MARKET_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </div>
          </div>
        </div>
        {carrierRes.loaded && !carrierRes.error && <div className="carrier-result-count" aria-live="polite">
          <span>Showing {filtered.length} of {carriers.length} carriers{carrierRes.loading ? " · Refreshing…" : ""}</span>
          {filtersActive && <button className="carrier-text-button" onClick={clearFilters}>Clear filters</button>}
        </div>}
        {!carrierRes.loaded ? (
          <p className="muted small">Loading…</p>
        ) : carrierRes.error ? (
          <p className="error-text" role="alert">{carrierRes.error} <button className="secondary" disabled={carrierRes.loading} onClick={() => void carrierRes.refetch()}>Retry carriers</button></p>
        ) : carriers.length === 0 ? (
          <p className="muted small">No carriers yet.</p>
        ) : filtered.length === 0 ? (
          <div className="carrier-empty"><p>No carriers match these filters.</p></div>
        ) : (
          <div className="table-wrap">
            <table className="carrier-table" aria-label="Carrier directory">
              <thead>
                <tr>
                  <CarrierSortTh label="Carrier" colKey="name" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <CarrierSortTh label="Status" colKey="status" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <CarrierSortTh label="Market" colKey="market" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <CarrierSortTh label="Underwriter" colKey="underwriter" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <CarrierSortTh label="Commission" colKey="commission" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <CarrierSortTh label="States" colKey="states" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <th>Lines written</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((c) => {
                  const cGuides = guides.filter((g) => g.carrierId === c.id);
                  const lines = [
                    ...new Set(cGuides.flatMap((g) => g.linesWritten ?? []).filter(Boolean)),
                  ];
                  // Derived from the guides, exactly as `lines` is, because
                  // paper is a property of the programme: a carrier doing
                  // both shows "Admitted, E&S" without a column that has to
                  // say "both" and then can't say which band is which.
                  const paper = [
                    ...new Set(cGuides.map((g) => g.paperType).filter(Boolean)),
                  ].map((pt) => PAPER_TYPE_LABELS[pt as string]);
                  const states = recordedStates(c);
                  return (
                    <tr
                      key={c.id}
                      className="clickable"
                      onClick={(event) => {
                        if (!(event.target as HTMLElement).closest("a, button, details")) navigate(`/carriers/${c.id}`);
                      }}
                    >
                      <td>
                        <Link to={`/carriers/${c.id}`} className="carrier-name">{c.name}</Link>
                      </td>
                      <td>
                        <Badge {...flagBadge(c.appointed, CARRIER_APPOINTMENT_BADGE)} />
                      </td>
                      <td className="small">
                        {c.marketType ? MARKET_TYPE_LABELS[c.marketType] : "—"}
                        <span className="carrier-paper muted">{guidesAvailable ? paper.join(", ") || "—" : guideRes.error ? "Unavailable" : "Loading appetite…"}</span>
                      </td>
                      <td>{c.primaryUnderwriterName ?? "—"}</td>
                      <td>{c.standardCommissionPct != null ? `${c.standardCommissionPct}%` : "—"}</td>
                      <td className="small">
                        {states.length > 1 ? <details className="carrier-metadata" onClick={(event) => event.stopPropagation()}>
                          <summary aria-label={`Coverage for ${c.name}`}>{states.length} states</summary>
                          <p>{states.join(", ")}</p>
                        </details> : states[0] || <span className="muted">Not recorded</span>}
                      </td>
                      <td className="small carrier-lines">{!guidesAvailable ? <span className="muted">{guideRes.error ? "Unavailable" : "Loading appetite…"}</span> : lines.length > 2 ? <details className="carrier-metadata" onClick={(event) => event.stopPropagation()}>
                        <summary aria-label={`Lines written for ${c.name}`}>{lines.slice(0, 2).join(", ")} <span className="carrier-more">+{lines.length - 2} more</span></summary>
                        <p>{lines.join(", ")}</p>
                      </details> : lines.join(", ") || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * "Where do I submit this risk?" — filters appointed carriers against their
 * appetite guides.
 *
 * The rules live in `lib/appetite.ts`, shared with the nightly renewal sweep.
 * They used to be written out here and again in the Lambda, under a comment
 * promising the two agreed.
 */
function AppetiteFinder({
  carriers,
  guides,
  available,
}: {
  carriers: Carrier[];
  guides: AppetiteGuide[];
  available: boolean;
}) {
  const [state, setState] = useState("");
  const [tiv, setTiv] = useState("");
  const [year, setYear] = useState("");
  const [paperType, setPaperType] = useState("");
  // "" / "yes" / "no" — an unanswered coastal question must not read as "no",
  // or every carrier declining the coast would surface for a beach-front risk.
  const [coastal, setCoastal] = useState("");
  const [milesToCoast, setMilesToCoast] = useState("");
  const [rentalPct, setRentalPct] = useState("");
  const [lossCount, setLossCount] = useState("");
  const [lossIncurred, setLossIncurred] = useState("");

  const criteria = [
    state,
    tiv,
    year,
    paperType,
    coastal,
    milesToCoast,
    rentalPct,
    lossCount,
    lossIncurred,
  ];
  const active = criteria.some(Boolean);
  const activeCount = criteria.filter(Boolean).length;
  const advancedCount = [year, milesToCoast, rentalPct, lossCount, lossIncurred].filter(Boolean).length;

  function clearRisk() {
    setState("");
    setTiv("");
    setYear("");
    setPaperType("");
    setCoastal("");
    setMilesToCoast("");
    setRentalPct("");
    setLossCount("");
    setLossIncurred("");
  }

  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  const risk: AppetiteRisk = {
    state: state || null,
    totalInsuredValue: num(tiv),
    yearBuilt: num(year),
    paperType: (paperType as PaperType) || null,
    coastal: coastal === "yes" ? true : coastal === "no" ? false : null,
    milesToCoast: num(milesToCoast),
    rentalPct: num(rentalPct),
    lossCount: num(lossCount),
    lossIncurred: num(lossIncurred),
  };

  const matches = !active || !available
    ? []
    : carriers
        .filter((c) => c.appointed)
        .map((c) => ({
          carrier: c,
          guides: guides.filter(
            (g) => g.carrierId === c.id && guideFits(g, c, risk)
          ),
        }))
        .filter((m) => m.guides.length > 0);

  return (
    <details className="card carrier-finder">
      <summary aria-label="Appetite finder" className="carrier-finder-summary">
        <span><strong>Appetite finder</strong><span className="muted small">Match a risk to appointed carriers</span></span>
        <span className="carrier-finder-summary-end">{active && <span className="badge blue">{activeCount} {activeCount === 1 ? "criterion" : "criteria"}</span>}<span className="carrier-chevron" aria-hidden="true">⌄</span></span>
      </summary>
      <div className="carrier-finder-body">
      <div className="carrier-risk-primary">
        <div className="field">
          <label htmlFor="risk-state">State</label>
          <select id="risk-state" value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">Any</option>
            {US_STATES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="risk-tiv">TIV ($)</label>
          <input id="risk-tiv" type="number" min={0} placeholder="Any value" value={tiv} onChange={(e) => setTiv(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="risk-paper">Paper</label>
          <select id="risk-paper" value={paperType} onChange={(e) => setPaperType(e.target.value)}>
            <option value="">Any</option>
            {PAPER_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="risk-coastal">Coastal?</label>
          <select id="risk-coastal" value={coastal} onChange={(e) => setCoastal(e.target.value)}>
            <option value="">Any</option>
            <option value="yes">Coastal</option>
            <option value="no">Not coastal</option>
          </select>
        </div>
      </div>
      <details className="carrier-risk-advanced">
        <summary>More risk details{advancedCount > 0 && <span className="badge blue">{advancedCount} filled</span>}</summary>
        <div className="carrier-risk-secondary">
        <div className="field">
          <label htmlFor="risk-year">Year built</label>
          <input id="risk-year" type="number" value={year} onChange={(e) => setYear(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="risk-coast-distance">Miles to coast</label>
          <input
            id="risk-coast-distance"
            type="number"
            min={0}
            step="0.1"
            value={milesToCoast}
            onChange={(e) => setMilesToCoast(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="risk-rental">Rented units (%)</label>
          <input
            id="risk-rental"
            type="number"
            min={0}
            max={100}
            value={rentalPct}
            onChange={(e) => setRentalPct(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="risk-losses">Losses (last {LOSS_LOOKBACK_YEARS} yrs)</label>
          <input
            id="risk-losses"
            type="number"
            min={0}
            value={lossCount}
            onChange={(e) => setLossCount(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="risk-incurred">Incurred, paid + reserved ($)</label>
          <input
            id="risk-incurred"
            type="number"
            min={0}
            value={lossIncurred}
            onChange={(e) => setLossIncurred(e.target.value)}
          />
        </div>
      </div>
      </details>
      <div className="carrier-finder-help">
        <p className="muted small">{active ? "Matches use all entered details, including collapsed fields." : "Enter the risk details you know to see matching appetite guides."}</p>
        {active && <button className="carrier-text-button" onClick={clearRisk}>Clear risk details</button>}
      </div>
      {!available && <p className="muted small" role="status">Appetite results are unavailable until carriers and guides finish loading successfully.</p>}
      {active && available && (
        <div className="carrier-finder-results">
          {matches.length === 0 ? (
            <p className="muted small">No appointed carrier has appetite for this risk.</p>
          ) : (
            <>
            <p className="small carrier-match-count" aria-live="polite">{matches.length} appointed {matches.length === 1 ? "carrier matches" : "carriers match"} this risk</p>
            <div className="table-wrap">
              <table aria-label="Appetite matches">
                <thead>
                  <tr>
                    <th>Carrier</th>
                    <th>Market</th>
                    <th>Paper</th>
                    <th>Lines</th>
                    <th>Best fit</th>
                    <th>TIV range</th>
                    <th>Restrictions</th>
                    <th>Lead time</th>
                  </tr>
                </thead>
                <tbody>
                  {matches.map(({ carrier, guides: gs }) =>
                    gs.map((g) => (
                      <tr key={g.id}>
                        <td>
                          <Link to={`/carriers/${carrier.id}`} className="carrier-name">{carrier.name}</Link>
                        </td>
                        <td className="small">
                          {carrier.marketType
                            ? MARKET_TYPE_LABELS[carrier.marketType]
                            : "—"}
                        </td>
                        <td className="small">
                          {g.paperType ? PAPER_TYPE_LABELS[g.paperType] : "—"}
                        </td>
                        <td className="small">
                          {(g.linesWritten ?? []).filter(Boolean).join(", ") || "—"}
                        </td>
                        {/* Not a match criterion — see `bestFitBusiness`. It
                            is here to rank by eye what the columns cannot. */}
                        <td className="small">
                          {(g.bestFitBusiness ?? []).filter(Boolean).join(", ") || "—"}
                        </td>
                        <td className="small">
                          {fmtMoney(g.minValue)} – {fmtMoney(g.maxValue)}
                        </td>
                        <td className="small">{restrictionSummary(g) || "—"}</td>
                        <td className="small">
                          {g.quoteSubmissionLeadTimeDays != null
                            ? `${g.quoteSubmissionLeadTimeDays} days`
                            : "—"}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            </>
          )}
        </div>
      )}
      </div>
    </details>
  );
}
