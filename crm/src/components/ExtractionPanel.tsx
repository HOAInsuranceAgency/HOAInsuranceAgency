import { useEffect, useMemo, useRef, useState } from "react";
import { client, fmtMoney, friendlyError, type Account } from "../lib/client";

/**
 * AI document extraction: kick off the Claude extraction over the account's
 * OCR'd documents, then review each extracted field (value + confidence +
 * evidence) against the current record and apply the ones you accept.
 * Nothing is ever written without explicit review.
 */

interface ExtractedField {
  value: string | number | boolean | null;
  confidence: "high" | "medium" | "low";
  evidence: string | null;
  source: string | null;
}

interface ExtractionResult {
  [key: string]: unknown;
  buildings?: { label: string | null; sqft: number | null }[];
  summary?: string;
  extractedAt?: string;
  documentCount?: number;
}

const CONSTRUCTION_LABELS: Record<string, string> = {
  FRAME: "Frame",
  JOISTED_MASONRY: "Joisted Masonry",
  NON_COMBUSTIBLE: "Non-Combustible",
  MASONRY_NON_COMBUSTIBLE: "Masonry Non-Combustible",
  MODIFIED_FIRE_RESISTIVE: "Modified Fire Resistive",
  FIRE_RESISTIVE: "Fire Resistive",
};

// Field definitions: extraction key → label, current-value accessor, and
// how the value lands on the Account record ("patch") or in notes ("note").
interface FieldDef {
  key: string;
  label: string;
  kind: "patch" | "note";
  current: (a: Account) => string;
  display?: (v: ExtractedField["value"]) => string;
}

const fmtVal = (v: ExtractedField["value"]): string => {
  if (v == null) return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
};

const FIELD_DEFS: FieldDef[] = [
  { key: "contactFirstName", label: "Contact first name", kind: "patch", current: (a) => a.contactFirstName ?? "" },
  { key: "contactLastName", label: "Contact last name", kind: "patch", current: (a) => a.contactLastName ?? "" },
  { key: "contactEmail", label: "Contact email", kind: "patch", current: (a) => a.contactEmail ?? "" },
  { key: "contactPhone", label: "Contact phone", kind: "patch", current: (a) => a.contactPhone ?? "" },
  { key: "address", label: "Street address", kind: "patch", current: (a) => a.address ?? "" },
  { key: "city", label: "City", kind: "patch", current: (a) => a.city ?? "" },
  { key: "state", label: "State", kind: "patch", current: (a) => a.state ?? "" },
  { key: "zip", label: "ZIP", kind: "patch", current: (a) => a.zip ?? "" },
  { key: "unitCount", label: "Unit count", kind: "patch", current: (a) => a.unitCount?.toString() ?? "" },
  { key: "yearBuilt", label: "Year built", kind: "patch", current: (a) => a.yearBuilt?.toString() ?? "" },
  {
    key: "totalInsuredValue",
    label: "Total insured value",
    kind: "patch",
    current: (a) => (a.totalInsuredValue != null ? fmtMoney(a.totalInsuredValue) : ""),
    display: (v) => (typeof v === "number" ? fmtMoney(v) : fmtVal(v)),
  },
  {
    key: "constructionType",
    label: "Construction type",
    kind: "patch",
    current: (a) => (a.constructionType ? CONSTRUCTION_LABELS[a.constructionType] ?? a.constructionType : ""),
    display: (v) => (typeof v === "string" ? CONSTRUCTION_LABELS[v] ?? v : fmtVal(v)),
  },
  { key: "stories", label: "Stories", kind: "patch", current: (a) => a.stories?.toString() ?? "" },
  { key: "coastal", label: "Coastal", kind: "patch", current: (a) => (a.coastal == null ? "" : a.coastal ? "Yes" : "No") },
  { key: "milesToCoast", label: "Miles to coast", kind: "patch", current: (a) => a.milesToCoast?.toString() ?? "" },
  { key: "roofUpdatedYear", label: "Roof updated", kind: "patch", current: (a) => a.roofUpdatedYear?.toString() ?? "" },
  { key: "hvacUpdatedYear", label: "HVAC updated", kind: "patch", current: (a) => a.hvacUpdatedYear?.toString() ?? "" },
  { key: "electricalUpdatedYear", label: "Electrical updated", kind: "patch", current: (a) => a.electricalUpdatedYear?.toString() ?? "" },
  { key: "plumbingUpdatedYear", label: "Plumbing updated", kind: "patch", current: (a) => a.plumbingUpdatedYear?.toString() ?? "" },
  { key: "firewallsVerified", label: "Firewalls verified", kind: "patch", current: (a) => (a.firewallsVerified == null ? "" : a.firewallsVerified ? "Yes" : "No") },
  { key: "currentCarrier", label: "Current carrier → notes", kind: "note", current: () => "" },
  {
    key: "currentAnnualPremium",
    label: "Current premium → notes",
    kind: "note",
    current: () => "",
    display: (v) => (typeof v === "number" ? fmtMoney(v) : fmtVal(v)),
  },
  {
    key: "currentPolicyExpiration",
    label: "Current policy expiration",
    kind: "patch",
    current: (a) => a.currentPolicyExpiration ?? "",
  },
];

function parseExtraction(raw: unknown): ExtractionResult | null {
  let v: unknown = raw;
  try {
    if (typeof v === "string") v = JSON.parse(v);
    if (typeof v === "string") v = JSON.parse(v);
  } catch {
    return null;
  }
  return v && typeof v === "object" ? (v as ExtractionResult) : null;
}

const CONF_BADGE: Record<string, string> = { high: "green", medium: "amber", low: "red" };

export default function ExtractionPanel({
  account,
  onChange,
}: {
  account: Account;
  onChange: (a: Account) => void;
}) {
  const [starting, setStarting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const [applied, setApplied] = useState(false);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [selectedBuildings, setSelectedBuildings] = useState<Record<number, boolean>>({});
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const status = account.extractionStatus;
  const result = useMemo(() => parseExtraction(account.aiExtraction), [account.aiExtraction]);

  // Poll while an extraction is in flight (30-90s typical).
  useEffect(() => {
    if (status === "PENDING" || status === "PROCESSING") {
      pollRef.current = setInterval(async () => {
        const { data } = await client.models.Account.get({ id: account.id });
        if (data && data.extractionStatus !== status) onChange(data);
      }, 4000);
      return () => {
        if (pollRef.current) clearInterval(pollRef.current);
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, account.id]);

  // Pre-select high/medium confidence fields whenever a new result arrives.
  useEffect(() => {
    if (!result) return;
    const initial: Record<string, boolean> = {};
    for (const def of FIELD_DEFS) {
      const f = result[def.key] as ExtractedField | undefined;
      if (f?.value != null) initial[def.key] = f.confidence !== "low";
    }
    setSelected(initial);
    const b: Record<number, boolean> = {};
    (result.buildings ?? []).forEach((_, i) => (b[i] = true));
    setSelectedBuildings(b);
    setApplied(false);
  }, [result]);

  async function start() {
    setStarting(true);
    setError("");
    try {
      const { errors } = await client.mutations.startLeadExtraction({
        accountId: account.id,
      });
      if (errors?.length) throw new Error(errors[0].message);
      const { data } = await client.models.Account.get({ id: account.id });
      if (data) onChange(data);
    } catch (err) {
      setError(friendlyError(err, "Could not start extraction"));
    } finally {
      setStarting(false);
    }
  }

  async function apply() {
    if (!result) return;
    setApplying(true);
    setError("");
    try {
      const patch: Record<string, unknown> = {};
      const noteLines: string[] = [];
      for (const def of FIELD_DEFS) {
        if (!selected[def.key]) continue;
        const f = result[def.key] as ExtractedField | undefined;
        if (f?.value == null) continue;
        if (def.kind === "patch") {
          patch[def.key] = f.value;
        } else {
          noteLines.push(`${def.label.replace(" → notes", "")}: ${fmtVal(f.value)}`);
        }
      }
      if (noteLines.length) {
        patch.notes = [account.notes, `[From documents] ${noteLines.join(" · ")}`]
          .filter(Boolean)
          .join("\n");
      }

      const { data, errors } = await client.models.Account.update({
        id: account.id,
        ...patch,
      });
      if (errors?.length || !data) throw new Error(errors?.[0]?.message);

      const buildings = (result.buildings ?? []).filter((_, i) => selectedBuildings[i]);
      for (const [i, b] of buildings.entries()) {
        await client.models.Building.create({
          accountId: account.id,
          label: b.label ?? `Building ${i + 1}`,
          sqft: b.sqft ?? undefined,
        });
      }

      onChange(data);
      setApplied(true);
    } catch (err) {
      setError(friendlyError(err, "Apply failed"));
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="card">
      <h2>AI data extraction</h2>
      <p className="muted small">
        Reads every OCR'd document on this account and extracts the datapoints
        the CRM tracks — with evidence, so you can verify before anything is
        written to the record.
      </p>

      <div className="toolbar">
        <button
          className="primary"
          disabled={starting || status === "PENDING" || status === "PROCESSING"}
          onClick={start}
        >
          {status === "PENDING" || status === "PROCESSING"
            ? "Extracting… (30–90s)"
            : starting
              ? "Starting…"
              : result
                ? "Re-run extraction"
                : "Extract data from documents"}
        </button>
        {status === "FAILED" && (
          <span className="error-text">
            {account.extractionError ?? "Extraction failed"}
          </span>
        )}
        {error && <span className="error-text">{error}</span>}
      </div>

      {result && status === "COMPLETE" && (
        <>
          {result.summary && (
            <p className="small" style={{ background: "#f0f7fb", padding: "10px 12px", borderRadius: 6 }}>
              {result.summary}
            </p>
          )}

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th></th>
                  <th>Field</th>
                  <th>Current</th>
                  <th>Extracted</th>
                  <th>Confidence</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {FIELD_DEFS.map((def) => {
                  const f = result[def.key] as ExtractedField | undefined;
                  if (!f || f.value == null) return null;
                  const cur = def.current(account);
                  const extracted = def.display ? def.display(f.value) : fmtVal(f.value);
                  return (
                    <tr key={def.key}>
                      <td>
                        <input
                          type="checkbox"
                          checked={!!selected[def.key]}
                          onChange={(e) =>
                            setSelected((s) => ({ ...s, [def.key]: e.target.checked }))
                          }
                        />
                      </td>
                      <td>{def.label}</td>
                      <td className="small muted">{cur || "—"}</td>
                      <td>
                        <strong>{extracted}</strong>
                      </td>
                      <td>
                        <span className={`badge ${CONF_BADGE[f.confidence] ?? "gray"}`}>
                          {f.confidence}
                        </span>
                      </td>
                      <td className="small muted" style={{ maxWidth: 320 }}>
                        {f.evidence ?? "—"}
                        {f.source && <div>({f.source})</div>}
                      </td>
                    </tr>
                  );
                })}
                {(result.buildings ?? []).map((b, i) => (
                  <tr key={`b-${i}`}>
                    <td>
                      <input
                        type="checkbox"
                        checked={!!selectedBuildings[i]}
                        onChange={(e) =>
                          setSelectedBuildings((s) => ({ ...s, [i]: e.target.checked }))
                        }
                      />
                    </td>
                    <td>Building</td>
                    <td className="small muted">—</td>
                    <td>
                      <strong>
                        {b.label ?? `Building ${i + 1}`}
                        {b.sqft ? ` · ${b.sqft.toLocaleString()} sq ft` : ""}
                      </strong>
                    </td>
                    <td>
                      <span className="badge gray">add</span>
                    </td>
                    <td className="small muted">Creates a Building record</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="form-actions">
            <button className="primary" disabled={applying} onClick={apply}>
              {applying ? "Applying…" : "Apply selected to lead"}
            </button>
            {applied && (
              <span className="small" style={{ color: "var(--green)" }}>
                Applied — review the Overview and Property tabs.
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
