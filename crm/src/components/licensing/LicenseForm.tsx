import { Select } from "../ui/Select";
import { Input } from "../ui/Input";
import { Textarea } from "../ui/Textarea";
import { Button } from "../ui/Button";
import { useSaveStatus } from "../SaveStatus";
import { str } from "../../lib/formCodec";
import {
  client,
  unwrap,
  LINES_OF_AUTHORITY,
  US_STATES,
  type License,
  type UserProfile,
} from "../../lib/client";
import {
  LICENSE_CLASS_LABELS,
  LICENSE_RESIDENCY_OPTIONS,
  LICENSE_STATUS_LABELS,
} from "../../../../shared/enums";
import { useFormState } from "../../lib/useFormState";
import type { HolderType } from "./holder";

export default function LicenseForm({
  holderType,
  existing,
  profiles,
  onCancel,
  onSaved,
  onSaving,
}: {
  holderType: HolderType;
  existing: License | null;
  profiles: UserProfile[];
  onCancel: () => void;
  onSaved: (l: License) => void;
  onSaving?: (saving: boolean) => void;
}) {
  const saveStatus = useSaveStatus({ singleFlight: true });
  const { busy: saving } = saveStatus;
  const error = saveStatus.status.state === "error" ? saveStatus.status.message : "";
  const { form, setF, markSaved } = useFormState({
    userProfileId: existing?.userProfileId ?? "",
    state: existing?.state ?? "",
    licenseNumber: existing?.licenseNumber ?? "",
    npn: existing?.npn ?? "",
    // Held as plain strings, as they always were: these three are `<select>`
    // values, and the payload below already casts them back to their enums.
    // (The curried setter erased the type by spreading a computed key; the
    // typed setter needs it said out loud.)
    licenseClass: (existing?.licenseClass ??
      (holderType === "FIRM" ? "AGENCY" : "PRODUCER")) as string,
    residency: (existing?.residency ?? "NON_RESIDENT") as string,
    status: (existing?.status ?? "ACTIVE") as string,
    effectiveDate: existing?.effectiveDate ?? "",
    expirationDate: existing?.expirationDate ?? "",
    continuingEducationDueDate: existing?.continuingEducationDueDate ?? "",
    notes: existing?.notes ?? "",
    // Was hoisted out of `form` only because the curried setter couldn't type
    // a `string[]`; it is a field like any other.
    loa: (existing?.linesOfAuthority ?? []).filter((x): x is string => !!x),
  }, { onEdit: saveStatus.markDirty });

  async function save() {
    const submitted = form;
    if (saveStatus.isPending()) return;
    if (!form.state || !form.licenseNumber.trim()) {
      saveStatus.markError("State and license number are required.");
      return;
    }
    if (holderType === "PRODUCER" && !form.userProfileId) {
      saveStatus.markError("Pick which team member this license belongs to.");
      return;
    }
    if (
      form.effectiveDate &&
      form.expirationDate &&
      form.effectiveDate > form.expirationDate
    ) {
      saveStatus.markError("Effective date can't be after the expiration date.");
      return;
    }
    const holder = profiles.find((p) => p.id === form.userProfileId);
    const payload = {
      holderType,
      // Omitted (not null) for firm licenses — see the schema note.
      userProfileId: holderType === "PRODUCER" ? form.userProfileId : undefined,
      holderName:
        holderType === "PRODUCER" && holder
          ? `${holder.firstName} ${holder.lastName}`
          : null,
      state: form.state,
      licenseNumber: form.licenseNumber.trim(),
      npn: str(form.npn),
      licenseClass: form.licenseClass as never,
      residency: form.residency as never,
      status: form.status as never,
      linesOfAuthority: form.loa,
      effectiveDate: form.effectiveDate || null,
      expirationDate: form.expirationDate || null,
      continuingEducationDueDate: form.continuingEducationDueDate || null,
      notes: str(form.notes),
    };
    await saveStatus.run(async current => {
      onSaving?.(true);
      try {
        const response = existing
          ? await client.models.License.update({ id: existing.id, ...payload })
          : await client.models.License.create(payload);
        const data = unwrap(response);
        if (current()) { markSaved(submitted); onSaved(data); }
      } finally { onSaving?.(false); }
    }, { errorMessage: 'Save failed' });
  }

  /**
   * Body only — no card, no heading. The caller renders this inside `Modal`,
   * which supplies the box and the title, and a second heading inside it read
   * as a nested panel. Kept as a fragment so the modal's own scrolling body is
   * the only scroll container.
   */
  return (
    <fieldset disabled={saving} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <div className="form-grid">
        {holderType === "PRODUCER" && (
          <div className="field">
            <label>Team member *</label>
            <Select value={form.userProfileId} onChange={(e) => setF("userProfileId", e.target.value)}>
              <option value="">—</option>
              {[...profiles]
                .sort((a, b) =>
                  `${a.lastName}${a.firstName}`.localeCompare(
                    `${b.lastName}${b.firstName}`
                  )
                )
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.firstName} {p.lastName}
                  </option>
                ))}
            </Select>
          </div>
        )}
        <div className="field">
          <label>State *</label>
          <Select value={form.state} onChange={(e) => setF("state", e.target.value)}>
            <option value="">—</option>
            {US_STATES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
        </div>
        <div className="field">
          <label>License number *</label>
          <Input value={form.licenseNumber} onChange={(e) => setF("licenseNumber", e.target.value)} />
        </div>
        <div className="field">
          <label>NPN</label>
          <Input value={form.npn} onChange={(e) => setF("npn", e.target.value)} />
        </div>
        <div className="field">
          <label>License class</label>
          <Select value={form.licenseClass} onChange={(e) => setF("licenseClass", e.target.value)}>
            {Object.entries(LICENSE_CLASS_LABELS)
              .sort((a, b) => a[1].localeCompare(b[1]))
              .map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
          </Select>
        </div>
        <div className="field">
          <label>Residency</label>
          <Select value={form.residency} onChange={(e) => setF("residency", e.target.value)}>
            {LICENSE_RESIDENCY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="field">
          <label>Status</label>
          <Select value={form.status} onChange={(e) => setF("status", e.target.value)}>
            {Object.entries(LICENSE_STATUS_LABELS)
              .sort((a, b) => a[1].localeCompare(b[1]))
              .map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
          </Select>
        </div>
        <div className="field">
          <label>Effective date</label>
          <Input type="date" value={form.effectiveDate} onChange={(e) => setF("effectiveDate", e.target.value)} />
        </div>
        <div className="field">
          <label>Expiration date</label>
          <Input type="date" value={form.expirationDate} onChange={(e) => setF("expirationDate", e.target.value)} />
        </div>
        <div className="field">
          <label>CE due date</label>
          <Input
            type="date"
            value={form.continuingEducationDueDate}
            onChange={(e) => setF("continuingEducationDueDate", e.target.value)}
          />
        </div>
        <div className="field full">
          <label>Lines of authority</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px" }}>
            {LINES_OF_AUTHORITY.map((l) => (
              <label
                key={l}
                className="small"
                style={{ display: "flex", gap: 4, alignItems: "center" }}
              >
                <Input
                  type="checkbox"
                  checked={form.loa.includes(l)}
                  onChange={() =>
                    setF("loa", (ls) =>
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
          <label>Notes</label>
          <Textarea rows={2} value={form.notes} onChange={(e) => setF("notes", e.target.value)} />
        </div>
      </div>
      <div className="form-actions">
        <Button variant="primary"  disabled={saving} onClick={save}>
          {saving ? "Saving…" : existing ? "Save changes" : "Add license"}
        </Button>
        <Button variant="link"  onClick={onCancel}>
          Cancel
        </Button>
        {error && <span role="alert" className="error-text">{error}</span>}
      </div>
      {!existing && (
        <p className="muted small">
          Save the license first, then use <em>Files</em> on its row to attach
          the license PDF and renewal paperwork.
        </p>
      )}
    </fieldset>
  );
}
