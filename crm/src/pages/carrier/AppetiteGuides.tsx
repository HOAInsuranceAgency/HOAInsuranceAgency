import { Button } from "../../components/ui/Button";
import { Table } from "../../components/ui/Table";
import { Input } from "../../components/ui/Input";
import { Select } from "../../components/ui/Select";
import { Textarea } from "../../components/ui/Textarea";
import { useState } from "react";
import { useSaveStatus } from "../../components/SaveStatus";
import { BEST_FIT_BUSINESS, assertNoErrors, client, fmtMoney, LINES_OF_BUSINESS, US_STATES, type AppetiteGuide } from "../../lib/client";
import { listAllPages } from "../../../../shared/pagination";
import ConfirmButton from "../../components/ConfirmButton";
import { useAsyncResource } from "../../lib/useAsyncResource";
import { useFormState } from "../../lib/useFormState";
import { bool, boolValue, num, str as nullableText, inputValue } from "../../lib/formCodec";
import { PAPER_TYPE_LABELS, PAPER_TYPE_OPTIONS, type PaperType } from "../../../../shared/enums";
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
     live: true }
  );
  const guides = res.data;
  const setGuides = res.setData;
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<AppetiteGuide | null>(null);


  async function del(id: string) {
    assertNoErrors(await client.models.AppetiteGuide.delete({ id }));
    setGuides((gs) => gs.filter((g) => g.id !== id));
  }

  return (
    <div className="card">
      <div className="toolbar" style={{ marginTop: 0, alignItems: "flex-start" }}>
        <div>
          <h2 style={{ margin: 0 }}>Appetite guides</h2>
          <p className="muted small" style={{ margin: "4px 0 0" }}>
            What this carrier will look at. Drives the Appetite Finder and the
            carrier submission workflow.
          </p>
        </div>
        <div className="grow" />
        <Button variant="primary"

          disabled={saving || !res.loaded || res.loading || !!res.error}
          onClick={() => {
            setEditing(null);
            setShowForm(!showForm);
          }}
        >
          {showForm ? "Cancel" : "+ Add appetite guide"}
        </Button>
      </div>

      {(showForm || editing) && (
        <GuideForm
          key={editing?.id ?? "new"}
          carrierId={carrierId}
          existing={editing}
          onBusyChange={setSaving}
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
        <p className="error-text" role="alert">{res.error} <Button disabled={res.loading} onClick={() => void res.refetch()}>Retry appetite guides</Button></p>
      ) : guides.length === 0 ? (
        <p className="muted small">No appetite guides recorded.</p>
      ) : (
        <div className="table-wrap">
          <Table>
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
                    <Button variant="link"

                      disabled={saving}
                      onClick={() => {
                        setShowForm(false);
                        setEditing(g);
                      }}
                    >
                      Edit
                    </Button>
                    <ConfirmButton
                      variant="link"
                      disabled={saving}
                      onConfirm={() => del(g.id)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
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
  onBusyChange,
}: {
  carrierId: string;
  existing: AppetiteGuide | null;
  onSaved: (g: AppetiteGuide) => void;
  onCancel: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const saveStatus = useSaveStatus({ singleFlight: true });
  const { busy: saving } = saveStatus;
  const error = saveStatus.status.state === "error" ? saveStatus.status.message : "";
  const { form, setF, markSaved } = useFormState({
    lines: (existing?.linesWritten ?? []).filter((l): l is string => !!l),
    bestFit: (existing?.bestFitBusiness ?? []).filter((b): b is string => !!b),
    states: (existing?.states ?? []).filter((s): s is string => !!s),
    paperType: existing?.paperType ?? "",
    leadTime: inputValue(existing?.quoteSubmissionLeadTimeDays),
    minValue: inputValue(existing?.minValue),
    maxValue: inputValue(existing?.maxValue),
    minYear: inputValue(existing?.minConstructionYear),
    maxYear: inputValue(existing?.maxConstructionYear),
    // Tri-state, not a checkbox: "we don't write coastal" and "nobody has
    // said" are different answers, and only the first one should exclude a
    // coastal risk. Same reasoning as the GL/D&O application questions.
    writesCoastal: boolValue(existing?.writesCoastal),
    minMilesToCoast: inputValue(existing?.minMilesToCoast),
    maxRentalPct: inputValue(existing?.maxRentalPct),
    maxLosses: inputValue(existing?.maxLosses),
    maxLossIncurred: inputValue(existing?.maxLossIncurred),
    notes: existing?.notes ?? "",
  }, { onEdit: saveStatus.markDirty });

  async function save() {
    const submitted = form;
    if (saveStatus.isPending()) return;
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
      saveStatus.markError(problems.join(" "));
      return;
    }
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
      notes: nullableText(form.notes),
    };
    await saveStatus.run(async current => {
      onBusyChange(true);
      try {
      const result = existing
        ? await client.models.AppetiteGuide.update({ id: existing.id, ...payload })
        : await client.models.AppetiteGuide.create({ carrierId, ...payload });
      assertNoErrors(result);
      if (!result.data) throw new Error('No saved guide was returned.');
      if (current()) { markSaved(submitted); onSaved(result.data); }
      } finally { onBusyChange(false); }
    }, { errorMessage: "Save failed" });
  }

  return (
    <div className="card" style={{ background: "#f8fafc" }}>
      <h3 style={{ marginTop: 0 }}>
        {existing ? "Edit" : "Add"} appetite guide
      </h3>
      <fieldset disabled={saving} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}><div className="form-grid">
        <div className="field full">
          <label>Lines written</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px" }}>
            {LINES_OF_BUSINESS.map((l) => (
              <label
                key={l}
                className="small"
                style={{ display: "flex", gap: 4, alignItems: "center" }}
              >
                <Input
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
                <Input
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
          <Select
            value={form.paperType}
            onChange={(e) => setF("paperType", e.target.value)}
          >
            <option value="">—</option>
            {PAPER_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="field">
          <label>Submission lead time (days)</label>
          <Input
            type="number"
            min={0}
            value={form.leadTime}
            onChange={(e) => setF("leadTime", e.target.value)}
          />
        </div>
        <div className="field">
          <label>Min TIV ($)</label>
          <Input type="number" value={form.minValue} onChange={(e) => setF("minValue", e.target.value)} />
        </div>
        <div className="field">
          <label>Max TIV ($)</label>
          <Input type="number" value={form.maxValue} onChange={(e) => setF("maxValue", e.target.value)} />
        </div>
        <div className="field">
          <label>Earliest construction year</label>
          <Input type="number" value={form.minYear} onChange={(e) => setF("minYear", e.target.value)} />
        </div>
        <div className="field">
          <label>Latest construction year</label>
          <Input type="number" value={form.maxYear} onChange={(e) => setF("maxYear", e.target.value)} />
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
          <Select
            value={form.writesCoastal}
            onChange={(e) => setF("writesCoastal", e.target.value)}
          >
            <option value="">— not stated</option>
            <option value="yes">Yes — writes coastal</option>
            <option value="no">No — declines coastal</option>
          </Select>
        </div>
        <div className="field">
          <label>Minimum miles to coast</label>
          <Input
            type="number"
            min={0}
            step="0.1"
            value={form.minMilesToCoast}
            onChange={(e) => setF("minMilesToCoast", e.target.value)}
          />
        </div>
        <div className="field">
          <label>Max rentals (% of units)</label>
          <Input
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
          <Input
            type="number"
            min={0}
            step="1"
            value={form.maxLosses}
            onChange={(e) => setF("maxLosses", e.target.value)}
          />
        </div>
        <div className="field">
          <label>Max incurred, paid + reserved ($)</label>
          <Input
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
                <Input
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
          <Textarea rows={2} value={form.notes} onChange={(e) => setF("notes", e.target.value)} />
        </div>
      </div>
      </fieldset>
      <div className="form-actions">
        <Button variant="primary"  disabled={saving} onClick={save}>
          {saving ? "Saving…" : existing ? "Save changes" : "Add guide"}
        </Button>
        <Button variant="link"  disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        {error && <span className="error-text" role="alert">{error}</span>}
      </div>
    </div>
  );
}
