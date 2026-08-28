import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  client,
  fmtMoney,
  US_STATES,
  type AppetiteGuide,
  type Carrier,
} from "../lib/client";
import { Badge, flagBadge, CARRIER_APPOINTMENT_BADGE } from "../lib/badges";
import {
  MARKET_TYPE_LABELS,
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

export default function Carriers() {
  const [showForm, setShowForm] = useState(false);
  // Persistent: a successful create navigates away, so what this is really
  // for is the failure that used to be swallowed entirely.
  const saveStatus = useSaveStatus();
  const { form, setF } = useFormState(
    { name: "", appointed: true },
    { onEdit: saveStatus.markDirty }
  );
  const navigate = useNavigate();

  const carrierRes = useAsyncResource(
    async () => (await client.models.Carrier.list()).data,
    [],
    { initialData: [] as Carrier[], errorMessage: "Failed to load carriers" }
  );
  const carriers = carrierRes.data;

  // Surfaced, not ignored: the guides drive the appetite finder's verdict and
  // the "Lines written" column. Without them the finder answers "no appetite"
  // for every risk, which is a wrong answer rather than a missing one.
  const guideRes = useAsyncResource(
    async () => (await client.models.AppetiteGuide.list()).data,
    [],
    { initialData: [] as AppetiteGuide[], errorMessage: "Failed to load appetite guides" }
  );
  const guides = guideRes.data;

  const { sorted, sortKey, dir, toggle } = useSort(
    carriers,
    {
      name: (c) => c.name,
      status: (c) => (c.appointed ? "Appointed" : "Prospective"),
      underwriter: (c) => c.primaryUnderwriterName,
      market: (c) => (c.marketType ? MARKET_TYPE_LABELS[c.marketType] : null),
      commission: (c) => c.standardCommissionPct,
      states: (c) => (c.states ?? []).filter(Boolean).length || null,
    },
    "name"
  );

  async function create() {
    if (!form.name.trim()) return;
    await saveStatus.run(
      async () => {
        // `errors` used to be dropped: a rejected create just re-enabled the
        // button, leaving no carrier and no explanation.
        const { data, errors } = await client.models.Carrier.create({
          name: form.name.trim(),
          appointed: form.appointed,
        });
        if (errors?.length || !data) throw new Error(errors?.[0]?.message);
        navigate(`/carriers/${data.id}`);
      },
      { errorMessage: "Couldn't create that carrier." }
    );
  }

  return (
    <>
      <h1>Carriers</h1>
      <p className="sub">Appointments, prospective appointments, and appetite guides</p>

      {/* Gated on `loaded`: the finder answers "no appointed carrier has
          appetite for this risk", and before the reads land that is a false
          negative rather than a placeholder. */}
      {carrierRes.loaded && guideRes.loaded && (
        <AppetiteFinder carriers={carriers} guides={guides} />
      )}
      {guideRes.error && <p className="error-text">{guideRes.error}</p>}

      <div className="toolbar">
        <div className="grow" />
        <button className="primary" onClick={() => setShowForm(!showForm)}>
          {showForm ? "Cancel" : "+ Add carrier"}
        </button>
      </div>

      {showForm && (
        <div className="card" style={{ background: "#f8fafc" }}>
          <div className="form-grid">
            <div className="field">
              <label>Carrier name *</label>
              <input value={form.name} onChange={(e) => setF("name", e.target.value)} />
            </div>
            <div className="field">
              <label>Status</label>
              <select
                value={form.appointed ? "1" : "0"}
                onChange={(e) => setF("appointed", e.target.value === "1")}
              >
                <option value="1">Appointed</option>
                <option value="0">Prospective</option>
              </select>
            </div>
          </div>
          <div className="form-actions">
            <button
              className="primary"
              disabled={saveStatus.busy || !form.name.trim()}
              onClick={create}
            >
              {saveStatus.busy ? "Creating…" : "Create carrier"}
            </button>
            <SaveStatus {...saveStatus.status} />
          </div>
        </div>
      )}

      <div className="card">
        {!carrierRes.loaded ? (
          <p className="muted small">Loading…</p>
        ) : carrierRes.error ? (
          <p className="error-text">{carrierRes.error}</p>
        ) : carriers.length === 0 ? (
          <p className="muted small">No carriers yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <SortTh label="Carrier" colKey="name" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Status" colKey="status" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Market" colKey="market" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <th>Paper</th>
                  <SortTh label="Underwriter" colKey="underwriter" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Commission" colKey="commission" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="States" colKey="states" sortKey={sortKey} dir={dir} onToggle={toggle} />
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
                  return (
                    <tr
                      key={c.id}
                      className="clickable"
                      onClick={() => navigate(`/carriers/${c.id}`)}
                    >
                      <td>
                        <strong>{c.name}</strong>
                      </td>
                      <td>
                        <Badge {...flagBadge(c.appointed, CARRIER_APPOINTMENT_BADGE)} />
                      </td>
                      <td className="small">
                        {c.marketType ? MARKET_TYPE_LABELS[c.marketType] : "—"}
                      </td>
                      <td className="small">{paper.join(", ") || "—"}</td>
                      <td>{c.primaryUnderwriterName ?? "—"}</td>
                      <td>{c.standardCommissionPct != null ? `${c.standardCommissionPct}%` : "—"}</td>
                      <td className="small">
                        {(c.states ?? []).filter(Boolean).join(", ") || "—"}
                      </td>
                      <td className="small">{lines.join(", ") || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
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
}: {
  carriers: Carrier[];
  guides: AppetiteGuide[];
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

  const matches = !active
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
    <div className="card">
      <h2>Appetite finder</h2>
      <div className="form-grid">
        <div className="field">
          <label>State</label>
          <select value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">Any</option>
            {US_STATES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>TIV ($)</label>
          <input type="number" value={tiv} onChange={(e) => setTiv(e.target.value)} />
        </div>
        <div className="field">
          <label>Year built</label>
          <input type="number" value={year} onChange={(e) => setYear(e.target.value)} />
        </div>
        <div className="field">
          <label>Paper</label>
          <select value={paperType} onChange={(e) => setPaperType(e.target.value)}>
            <option value="">Any</option>
            {PAPER_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Coastal?</label>
          <select value={coastal} onChange={(e) => setCoastal(e.target.value)}>
            <option value="">Any</option>
            <option value="yes">Coastal</option>
            <option value="no">Not coastal</option>
          </select>
        </div>
        <div className="field">
          <label>Miles to coast</label>
          <input
            type="number"
            min={0}
            step="0.1"
            value={milesToCoast}
            onChange={(e) => setMilesToCoast(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Rented units (%)</label>
          <input
            type="number"
            min={0}
            max={100}
            value={rentalPct}
            onChange={(e) => setRentalPct(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Losses (last {LOSS_LOOKBACK_YEARS} yrs)</label>
          <input
            type="number"
            min={0}
            value={lossCount}
            onChange={(e) => setLossCount(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Incurred, paid + reserved ($)</label>
          <input
            type="number"
            min={0}
            value={lossIncurred}
            onChange={(e) => setLossIncurred(e.target.value)}
          />
        </div>
      </div>
      {active && (
        <div style={{ marginTop: 14 }}>
          {matches.length === 0 ? (
            <p className="muted small">No appointed carrier has appetite for this risk.</p>
          ) : (
            <div className="table-wrap">
              <table>
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
                          <strong>{carrier.name}</strong>
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
          )}
        </div>
      )}
    </div>
  );
}
