import { useState } from "react";
import {
  BEST_FIT_BUSINESS,
  client,
  fmtMoney,
  friendlyError,
  LINES_OF_BUSINESS,
  listAllPages,
  US_STATES,
  type AppetiteGuide,
} from "../../lib/client";
import ConfirmButton from "../../components/ConfirmButton";
import { useAsyncResource } from "../../lib/useAsyncResource";
import { useFormState } from "../../lib/useFormState";
import { bool, boolValue } from "../../lib/formCodec";
import { PAPER_TYPE_LABELS, PAPER_TYPE_OPTIONS, type PaperType } from "../../lib/enums";
import { LOSS_LOOKBACK_YEARS, restrictionSummary } from "../../lib/appetite";

export function AppetiteGuides({ carrierId }: { carrierId: string }) {
  const res = useAsyncResource(
    async () =>
      (await listAllPages((nextToken) =>
        client.models.AppetiteGuide.list({
          filter: { carrierId: { eq: carrierId } },
          limit: 500,
          nextToken,
        })
      )) as AppetiteGuide[],
    [carrierId],
    {
      initialData: [] as AppetiteGuide[],
      // A failed read said "No appetite guides recorded.", so the next step is
      // adding a duplicate of a guide that already exists.
      errorMessage: "Failed to load appetite guides",
    }
  );
  const guides = res.data;
  const setGuides = res.setData;
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<AppetiteGuide | null>(null);


  async function del(id: string) {
    await client.models.AppetiteGuide.delete({ id });
    setGuides((gs) => gs.filter((g) => g.id !== id));
  }

  return (
    <div className="card">
      <div className="toolbar" style={{ marginTop: 0, alignItems: "flex-start" }}>
        <div>
          <h2 style={{ margin: 0 }}>Appetite guides</h2>
          <p className="muted small" style={{ margin: "4px 0 0" }}>
            What this carrier will look at. Drives the Appetite Finder and the
            daily renewal marketing sweep.
          </p>
        </div>
        <div className="grow" />
        <button
          className="primary"
          onClick={() => {
            setEditing(null);
            setShowForm(!showForm);
          }}
        >
          {showForm ? "Cancel" : "+ Add appetite guide"}
        </button>
      </div>

      {(showForm || editing) && (
        <GuideForm
          key={editing?.id ?? "new"}
          carrierId={carrierId}
          existing={editing}
          onSaved={(g) => {
            setGuides((gs) => {
              const without = gs.filter((x) => x.id !== g.id);
              return [...without, g];
            });
            setShowForm(false);
            setEditing(null);
          }}
          onCancel={() => {
            setShowForm(false);
            setEditing(null);
          }}
        />
      )}

      {!res.loaded ? (
        <p className="muted small">Loading…</p>
      ) : res.error ? (
        <p className="error-text">{res.error}</p>
      ) : guides.length === 0 ? (
        <p className="muted small">No appetite guides recorded.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Lines</th>
                <th>Paper</th>
                <th>Best fit</th>
                <th>Lead time</th>
                <th>TIV range</th>
                <th>Construction years</th>
                <th>Restrictions</th>
                <th>States</th>
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
                  <td className="small">
                    {g.paperType ? PAPER_TYPE_LABELS[g.paperType] : "—"}
                  </td>
                  <td className="small">
                    {(g.bestFitBusiness ?? []).filter(Boolean).join(", ") || "—"}
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
                  <td className="small">{restrictionSummary(g) || "—"}</td>
                  <td className="small">
                    {(g.states ?? []).filter(Boolean).join(", ") || "carrier default"}
                  </td>
                  <td className="small">{g.notes ?? ""}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button
                      className="link"
                      onClick={() => {
                        setShowForm(false);
                        setEditing(g);
                      }}
                    >
                      Edit
                    </button>
                    <ConfirmButton
                      className="link"
                      onConfirm={() => del(g.id)}
                    />
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

/** Create/edit one appetite guide. */
function GuideForm({
  carrierId,
  existing,
  onSaved,
  onCancel,
}: {
  carrierId: string;
  existing: AppetiteGuide | null;
  onSaved: (g: AppetiteGuide) => void;
  onCancel: () => void;
}) {
  // Read side: column value → input string. (Not `formCodec`'s `str`, which
  // runs the other way; that boundary is a separate migration.)
  const str = (n: number | null | undefined) => (n == null ? "" : String(n));
  const { form, setF } = useFormState({
    lines: (existing?.linesWritten ?? []).filter((l): l is string => !!l),
    bestFit: (existing?.bestFitBusiness ?? []).filter((b): b is string => !!b),
    states: (existing?.states ?? []).filter((s): s is string => !!s),
    paperType: existing?.paperType ?? "",
    leadTime: str(existing?.quoteSubmissionLeadTimeDays),
    minValue: str(existing?.minValue),
    maxValue: str(existing?.maxValue),
    minYear: str(existing?.minConstructionYear),
    maxYear: str(existing?.maxConstructionYear),
    // Tri-state, not a checkbox: "we don't write coastal" and "nobody has
    // said" are different answers, and only the first one should exclude a
    // coastal risk. Same reasoning as the GL/D&O application questions.
    writesCoastal: boolValue(existing?.writesCoastal),
    minMilesToCoast: str(existing?.minMilesToCoast),
    maxRentalPct: str(existing?.maxRentalPct),
    maxLosses: str(existing?.maxLosses),
    maxLossIncurred: str(existing?.maxLossIncurred),
    notes: existing?.notes ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    // Inverted ranges silently break the Appetite Finder — catch them here.
    const problems: string[] = [];
    if (form.minValue && form.maxValue && Number(form.minValue) > Number(form.maxValue))
      problems.push("Min TIV can't be greater than Max TIV.");
    if (form.minYear && form.maxYear && Number(form.minYear) > Number(form.maxYear))
      problems.push("Earliest construction year can't be after the latest.");
    if (
      (form.minValue && Number(form.minValue) < 0) ||
      (form.maxValue && Number(form.maxValue) < 0)
    )
      problems.push("TIV values can't be negative.");
    // A negative cap matches nothing at all, which reads in the Finder as
    // "no carrier wants this" rather than as the typo it is.
    if (
      [form.minMilesToCoast, form.maxRentalPct, form.maxLosses, form.maxLossIncurred]
        .some((v) => v && Number(v) < 0)
    )
      problems.push("Restriction limits can't be negative.");
    if (form.maxRentalPct && Number(form.maxRentalPct) > 100)
      problems.push("Rental percentage can't be over 100.");
    if (problems.length) {
      setError(problems.join(" "));
      return;
    }
    setError("");
    setSaving(true);
    const num = (v: string) => (v.trim() === "" ? null : Number(v));
    const payload = {
      linesWritten: form.lines,
      bestFitBusiness: form.bestFit,
      states: form.states,
      // "" is unstated, and the schema spells that null — an empty string
      // would fail enum validation.
      paperType: (form.paperType as PaperType) || null,
      quoteSubmissionLeadTimeDays: num(form.leadTime),
      minValue: num(form.minValue),
      maxValue: num(form.maxValue),
      minConstructionYear: num(form.minYear),
      maxConstructionYear: num(form.maxYear),
      writesCoastal: bool(form.writesCoastal),
      minMilesToCoast: num(form.minMilesToCoast),
      maxRentalPct: num(form.maxRentalPct),
      maxLosses: num(form.maxLosses),
      maxLossIncurred: num(form.maxLossIncurred),
      notes: form.notes.trim() || null,
    };
    const { data, errors } = existing
      ? await client.models.AppetiteGuide.update({ id: existing.id, ...payload })
      : await client.models.AppetiteGuide.create({ carrierId, ...payload });
    setSaving(false);
    if (errors?.length || !data) {
      setError(friendlyError(errors?.[0]?.message, "Save failed"));
      return;
    }
    onSaved(data);
  }

  return (
    <div className="card" style={{ background: "#f8fafc" }}>
      <h3 style={{ marginTop: 0 }}>
        {existing ? "Edit" : "Add"} appetite guide
      </h3>
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
                  checked={form.lines.includes(l)}
                  onChange={() =>
                    setF("lines", (ls) =>
                      ls.includes(l) ? ls.filter((x) => x !== l) : [...ls, l].sort()
                    )
                  }
                />
                {l}
              </label>
            ))}
          </div>
        </div>
        <div className="field full">
          <label>Best-fit business</label>
          <p className="muted small" style={{ margin: "0 0 6px" }}>
            What this programme is good at. Shown beside the results — it is
            not matched on, because nothing on an account records whether a
            condo is a clean one.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px" }}>
            {BEST_FIT_BUSINESS.map((b) => (
              <label
                key={b}
                className="small"
                style={{ display: "flex", gap: 4, alignItems: "center" }}
              >
                <input
                  type="checkbox"
                  checked={form.bestFit.includes(b)}
                  onChange={() =>
                    setF("bestFit", (bs) =>
                      bs.includes(b) ? bs.filter((x) => x !== b) : [...bs, b].sort()
                    )
                  }
                />
                {b}
              </label>
            ))}
          </div>
        </div>
        <div className="field">
          <label>Paper</label>
          <select
            value={form.paperType}
            onChange={(e) => setF("paperType", e.target.value)}
          >
            <option value="">—</option>
            {PAPER_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Submission lead time (days)</label>
          <input
            type="number"
            min={0}
            value={form.leadTime}
            onChange={(e) => setF("leadTime", e.target.value)}
          />
        </div>
        <div className="field">
          <label>Min TIV ($)</label>
          <input type="number" value={form.minValue} onChange={(e) => setF("minValue", e.target.value)} />
        </div>
        <div className="field">
          <label>Max TIV ($)</label>
          <input type="number" value={form.maxValue} onChange={(e) => setF("maxValue", e.target.value)} />
        </div>
        <div className="field">
          <label>Earliest construction year</label>
          <input type="number" value={form.minYear} onChange={(e) => setF("minYear", e.target.value)} />
        </div>
        <div className="field">
          <label>Latest construction year</label>
          <input type="number" value={form.maxYear} onChange={(e) => setF("maxYear", e.target.value)} />
        </div>
        <div className="field full">
          <h4 style={{ margin: "6px 0 0" }}>Key restrictions</h4>
          <p className="muted small" style={{ margin: "4px 0 0" }}>
            Each one is matched against what the account already records. Leave
            a limit blank and it never excludes anyone — restrictions that
            don't fit these boxes belong in the notes below.
          </p>
        </div>
        <div className="field">
          <label>Writes coastal?</label>
          <select
            value={form.writesCoastal}
            onChange={(e) => setF("writesCoastal", e.target.value)}
          >
            <option value="">— not stated</option>
            <option value="yes">Yes — writes coastal</option>
            <option value="no">No — declines coastal</option>
          </select>
        </div>
        <div className="field">
          <label>Minimum miles to coast</label>
          <input
            type="number"
            min={0}
            step="0.1"
            value={form.minMilesToCoast}
            onChange={(e) => setF("minMilesToCoast", e.target.value)}
          />
        </div>
        <div className="field">
          <label>Max rentals (% of units)</label>
          <input
            type="number"
            min={0}
            max={100}
            step="1"
            value={form.maxRentalPct}
            onChange={(e) => setF("maxRentalPct", e.target.value)}
          />
        </div>
        <div className="field">
          <label>Max losses (last {LOSS_LOOKBACK_YEARS} yrs)</label>
          <input
            type="number"
            min={0}
            step="1"
            value={form.maxLosses}
            onChange={(e) => setF("maxLosses", e.target.value)}
          />
        </div>
        <div className="field">
          <label>Max incurred, paid + reserved ($)</label>
          <input
            type="number"
            min={0}
            step="1"
            value={form.maxLossIncurred}
            onChange={(e) => setF("maxLossIncurred", e.target.value)}
          />
        </div>
        <div className="field full">
          <label>
            States ({form.states.length || "carrier default"})
          </label>
          <p className="muted small" style={{ margin: "0 0 6px" }}>
            Leave empty to use the carrier's states. Set them only when this
            guide is narrower than the carrier's overall footprint.
          </p>
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
                  onChange={() =>
                    setF("states", (ss) =>
                      ss.includes(s) ? ss.filter((x) => x !== s) : [...ss, s].sort()
                    )
                  }
                />
                {s}
              </label>
            ))}
          </div>
        </div>
        <div className="field full">
          <label>Notes</label>
          <textarea rows={2} value={form.notes} onChange={(e) => setF("notes", e.target.value)} />
        </div>
      </div>
      <div className="form-actions">
        <button className="primary" disabled={saving} onClick={save}>
          {saving ? "Saving…" : existing ? "Save changes" : "Add guide"}
        </button>
        <button className="link" onClick={onCancel}>
          Cancel
        </button>
        {error && <span className="error-text">{error}</span>}
      </div>
    </div>
  );
}
