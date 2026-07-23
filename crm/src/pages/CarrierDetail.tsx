import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  client,
  fmtMoney,
  LINES_OF_BUSINESS,
  US_STATES,
  type AppetiteGuide,
  type Carrier,
} from "../lib/client";
import DocumentsPanel from "../components/DocumentsPanel";

export default function CarrierDetail() {
  const { id } = useParams<{ id: string }>();
  const [carrier, setCarrier] = useState<Carrier | null>(null);

  useEffect(() => {
    if (!id) return;
    client.models.Carrier.get({ id }).then(({ data }) => setCarrier(data));
  }, [id]);

  if (!carrier) return <p className="muted">Loading…</p>;

  return (
    <>
      <h1>
        {carrier.name}{" "}
        <span className={`badge ${carrier.appointed ? "green" : "amber"}`}>
          {carrier.appointed ? "Appointed" : "Prospective"}
        </span>
      </h1>
      <p className="sub">Carrier appointment &amp; appetite</p>

      <CarrierForm carrier={carrier} onChange={setCarrier} />
      <AppetiteGuides carrierId={carrier.id} />

      <div className="card">
        <h2>Documents</h2>
        <DocumentsPanel entityType="CARRIER" entityId={carrier.id} />
      </div>
    </>
  );
}

function CarrierForm({
  carrier,
  onChange,
}: {
  carrier: Carrier;
  onChange: (c: Carrier) => void;
}) {
  const [form, setForm] = useState({
    name: carrier.name,
    appointed: carrier.appointed,
    dateAppointed: carrier.dateAppointed ?? "",
    primaryContactName: carrier.primaryContactName ?? "",
    primaryContactEmail: carrier.primaryContactEmail ?? "",
    primaryContactPhone: carrier.primaryContactPhone ?? "",
    primaryUnderwriterName: carrier.primaryUnderwriterName ?? "",
    primaryUnderwriterEmail: carrier.primaryUnderwriterEmail ?? "",
    primaryUnderwriterPhone: carrier.primaryUnderwriterPhone ?? "",
    states: (carrier.states ?? []).filter((s): s is string => !!s),
    naicCode: carrier.naicCode ?? "",
    standardCommissionPct: carrier.standardCommissionPct?.toString() ?? "",
    notes: carrier.notes ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const set =
    (k: keyof typeof form) =>
    (e: { target: { value: string } }) => {
      setSaved(false);
      setForm((f) => ({ ...f, [k]: e.target.value }));
    };

  function toggleState(s: string) {
    setSaved(false);
    setForm((f) => ({
      ...f,
      states: f.states.includes(s)
        ? f.states.filter((x) => x !== s)
        : [...f.states, s].sort(),
    }));
  }

  async function save() {
    setSaving(true);
    setError("");
    const { data, errors } = await client.models.Carrier.update({
      id: carrier.id,
      name: form.name.trim() || carrier.name,
      appointed: form.appointed,
      dateAppointed: form.dateAppointed || null,
      primaryContactName: form.primaryContactName.trim() || null,
      primaryContactEmail: form.primaryContactEmail.trim() || null,
      primaryContactPhone: form.primaryContactPhone.trim() || null,
      primaryUnderwriterName: form.primaryUnderwriterName.trim() || null,
      primaryUnderwriterEmail: form.primaryUnderwriterEmail.trim() || null,
      primaryUnderwriterPhone: form.primaryUnderwriterPhone.trim() || null,
      states: form.states,
      naicCode: form.naicCode.trim() || null,
      standardCommissionPct: form.standardCommissionPct
        ? Number(form.standardCommissionPct)
        : null,
      notes: form.notes.trim() || null,
    });
    setSaving(false);
    if (errors?.length || !data) {
      setError(errors?.[0]?.message ?? "Save failed");
      return;
    }
    onChange(data);
    setSaved(true);
  }

  return (
    <div className="card">
      <h2>Appointment details</h2>
      <div className="form-grid">
        <div className="field">
          <label>Name</label>
          <input value={form.name} onChange={set("name")} />
        </div>
        <div className="field">
          <label>Status</label>
          <select
            value={form.appointed ? "1" : "0"}
            onChange={(e) => {
              setSaved(false);
              setForm((f) => ({ ...f, appointed: e.target.value === "1" }));
            }}
          >
            <option value="1">Appointed</option>
            <option value="0">Prospective</option>
          </select>
        </div>
        <div className="field">
          <label>Date appointed</label>
          <input type="date" value={form.dateAppointed} onChange={set("dateAppointed")} />
        </div>
        <div className="field">
          <label>NAIC code</label>
          <input value={form.naicCode} onChange={set("naicCode")} />
        </div>
        <div className="field">
          <label>Standard commission % (autofills new quotes)</label>
          <input
            type="number"
            step="0.1"
            min={0}
            max={100}
            value={form.standardCommissionPct}
            onChange={set("standardCommissionPct")}
          />
        </div>
        <div className="field">
          <label>Primary contact</label>
          <input value={form.primaryContactName} onChange={set("primaryContactName")} />
        </div>
        <div className="field">
          <label>Contact email</label>
          <input value={form.primaryContactEmail} onChange={set("primaryContactEmail")} />
        </div>
        <div className="field">
          <label>Contact phone</label>
          <input value={form.primaryContactPhone} onChange={set("primaryContactPhone")} />
        </div>
        <div className="field">
          <label>Primary underwriter</label>
          <input
            value={form.primaryUnderwriterName}
            onChange={set("primaryUnderwriterName")}
          />
        </div>
        <div className="field">
          <label>Underwriter email</label>
          <input
            value={form.primaryUnderwriterEmail}
            onChange={set("primaryUnderwriterEmail")}
          />
        </div>
        <div className="field">
          <label>Underwriter phone</label>
          <input
            value={form.primaryUnderwriterPhone}
            onChange={set("primaryUnderwriterPhone")}
          />
        </div>
        <div className="field full">
          <label>States covered ({form.states.length})</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 10px" }}>
            {US_STATES.map((s) => (
              <label
                key={s}
                className="small"
                style={{ display: "flex", gap: 3, alignItems: "center" }}
              >
                <input
                  type="checkbox"
                  checked={form.states.includes(s)}
                  onChange={() => toggleState(s)}
                />
                {s}
              </label>
            ))}
          </div>
        </div>
        <div className="field full">
          <label>Notes</label>
          <textarea rows={3} value={form.notes} onChange={set("notes")} />
        </div>
      </div>
      <div className="form-actions">
        <button className="primary" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save changes"}
        </button>
        {saved && <span className="small" style={{ color: "var(--green)" }}>Saved.</span>}
        {error && <span className="error-text">{error}</span>}
      </div>
    </div>
  );
}

function AppetiteGuides({ carrierId }: { carrierId: string }) {
  const [guides, setGuides] = useState<AppetiteGuide[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [leadTime, setLeadTime] = useState("");
  const [minValue, setMinValue] = useState("");
  const [maxValue, setMaxValue] = useState("");
  const [minYear, setMinYear] = useState("");
  const [maxYear, setMaxYear] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    client.models.AppetiteGuide.list({
      filter: { carrierId: { eq: carrierId } },
    }).then(({ data }) => setGuides(data));
  }, [carrierId]);

  async function add() {
    // Inverted ranges silently break the Appetite Finder — catch them here.
    const problems: string[] = [];
    if (minValue && maxValue && Number(minValue) > Number(maxValue))
      problems.push("Min TIV can't be greater than Max TIV.");
    if (minYear && maxYear && Number(minYear) > Number(maxYear))
      problems.push("Earliest construction year can't be after the latest.");
    if ((minValue && Number(minValue) < 0) || (maxValue && Number(maxValue) < 0))
      problems.push("TIV values can't be negative.");
    if (problems.length) {
      setError(problems.join(" "));
      return;
    }
    setError("");
    setSaving(true);
    const { data } = await client.models.AppetiteGuide.create({
      carrierId,
      linesWritten: lines,
      quoteSubmissionLeadTimeDays: leadTime ? Number(leadTime) : undefined,
      minValue: minValue ? Number(minValue) : undefined,
      maxValue: maxValue ? Number(maxValue) : undefined,
      minConstructionYear: minYear ? Number(minYear) : undefined,
      maxConstructionYear: maxYear ? Number(maxYear) : undefined,
      notes: notes.trim() || undefined,
    });
    setSaving(false);
    if (data) {
      setGuides((gs) => [...gs, data]);
      setShowForm(false);
      setLines([]);
      setLeadTime("");
      setMinValue("");
      setMaxValue("");
      setMinYear("");
      setMaxYear("");
      setNotes("");
    }
  }

  async function del(id: string) {
    await client.models.AppetiteGuide.delete({ id });
    setGuides((gs) => gs.filter((g) => g.id !== id));
  }

  return (
    <div className="card">
      <h2>Appetite guides</h2>
      <div className="toolbar">
        <div className="grow" />
        <button className="primary" onClick={() => setShowForm(!showForm)}>
          {showForm ? "Cancel" : "+ Add appetite guide"}
        </button>
      </div>

      {showForm && (
        <div className="card" style={{ background: "#f8fafc" }}>
          <div className="form-grid">
            <div className="field full">
              <label>Lines written</label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px" }}>
                {LINES_OF_BUSINESS.map((l) => (
                  <label
                    key={l}
                    className="small"
                    style={{ display: "flex", gap: 4, alignItems: "center" }}
                  >
                    <input
                      type="checkbox"
                      checked={lines.includes(l)}
                      onChange={() =>
                        setLines((ls) =>
                          ls.includes(l) ? ls.filter((x) => x !== l) : [...ls, l]
                        )
                      }
                    />
                    {l}
                  </label>
                ))}
              </div>
            </div>
            <div className="field">
              <label>Submission lead time (days)</label>
              <input type="number" value={leadTime} onChange={(e) => setLeadTime(e.target.value)} />
            </div>
            <div className="field">
              <label>Min TIV ($)</label>
              <input type="number" value={minValue} onChange={(e) => setMinValue(e.target.value)} />
            </div>
            <div className="field">
              <label>Max TIV ($)</label>
              <input type="number" value={maxValue} onChange={(e) => setMaxValue(e.target.value)} />
            </div>
            <div className="field">
              <label>Earliest construction year</label>
              <input type="number" value={minYear} onChange={(e) => setMinYear(e.target.value)} />
            </div>
            <div className="field">
              <label>Latest construction year</label>
              <input type="number" value={maxYear} onChange={(e) => setMaxYear(e.target.value)} />
            </div>
            <div className="field full">
              <label>Notes</label>
              <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>
          <div className="form-actions">
            <button className="primary" disabled={saving} onClick={add}>
              {saving ? "Saving…" : "Add guide"}
            </button>
            {error && <span className="error-text">{error}</span>}
          </div>
        </div>
      )}

      {guides.length === 0 ? (
        <p className="muted small">No appetite guides recorded.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Lines</th>
                <th>Lead time</th>
                <th>TIV range</th>
                <th>Construction years</th>
                <th>Notes</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {guides.map((g) => (
                <tr key={g.id}>
                  <td className="small">
                    {(g.linesWritten ?? []).filter(Boolean).join(", ") || "—"}
                  </td>
                  <td>
                    {g.quoteSubmissionLeadTimeDays != null
                      ? `${g.quoteSubmissionLeadTimeDays} days`
                      : "—"}
                  </td>
                  <td className="small">
                    {fmtMoney(g.minValue)} – {fmtMoney(g.maxValue)}
                  </td>
                  <td className="small">
                    {g.minConstructionYear ?? "any"} – {g.maxConstructionYear ?? "any"}
                  </td>
                  <td className="small">{g.notes ?? ""}</td>
                  <td>
                    <button className="danger" onClick={() => del(g.id)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
