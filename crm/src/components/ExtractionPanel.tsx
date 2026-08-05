import { useEffect, useMemo, useRef, useState } from "react";
import {
  client,
  fmtMoney,
  fmtNum,
  fmtPhone,
  friendlyError,
  listAllPages,
  type Account,
  type Contact,
} from "../lib/client";
import { Badge, statusBadge, CONFIDENCE_BADGE } from "../lib/badges";
import { CONSTRUCTION_LABELS, CONTACT_TYPE_LABELS } from "../lib/enums";
import { str } from "../lib/formCodec";
import { contactKey } from "../lib/extractionKeys";
import { useAsyncResource } from "../lib/useAsyncResource";
import { SaveStatus, useSaveStatus } from "./SaveStatus";

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

interface ExtractedContact {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  type?: string | null;
}

interface ExtractionResult {
  [key: string]: unknown;
  contacts?: ExtractedContact[];
  buildings?: { label?: string | null; sqft?: string | number | null }[];
  summary?: string;
  extractedAt?: string;
  documentCount?: number;
}

/** A candidate worth showing: the model returned an entry with a name on it. */
const namedContact = (c: ExtractedContact) => Boolean(c?.name?.trim());

// Field definitions: extraction key → label, current-value accessor, and
// how the value lands on the Account record ("patch") or in notes ("note").
interface FieldDef {
  key: string;
  label: string;
  kind: "patch" | "note";
  vtype?: "int" | "float" | "bool"; // coercion for apply; default string
  current: (a: Account) => string;
  display?: (v: ExtractedField["value"]) => string;
  /** Lead-only field — hidden once the account is a client. */
  leadOnly?: boolean;
}

const fmtVal = (v: ExtractedField["value"]): string => {
  if (v == null || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
};

// Values arrive as strings ("" = not found). Coerce to the Account field's
// type before writing.
const isEmpty = (v: ExtractedField["value"]) => v == null || v === "";
function coerce(def: FieldDef, v: ExtractedField["value"]): unknown {
  if (isEmpty(v)) return undefined;
  const s = String(v).trim();
  if (def.vtype === "int") {
    const n = Math.round(Number(s.replace(/[^0-9.-]/g, "")));
    return Number.isFinite(n) ? n : undefined;
  }
  if (def.vtype === "float") {
    const n = Number(s.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  if (def.vtype === "bool") return /^(yes|true|y)$/i.test(s);
  return s;
}

const moneyDisplay = (v: ExtractedField["value"]): string => {
  if (isEmpty(v)) return "—";
  const n = Number(String(v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? fmtMoney(n) : fmtVal(v);
};

// The four flat `contact*` fields are gone from here: contacts are rows now,
// reviewed in their own section below, because a prior policy packet names
// several people and this table can only ever patch one of each column.
const ALL_FIELD_DEFS: FieldDef[] = [
  { key: "address", label: "Street address", kind: "patch", current: (a) => a.address ?? "" },
  { key: "city", label: "City", kind: "patch", current: (a) => a.city ?? "" },
  { key: "state", label: "State", kind: "patch", current: (a) => a.state ?? "" },
  { key: "zip", label: "ZIP", kind: "patch", current: (a) => a.zip ?? "" },
  { key: "unitCount", label: "Unit count", kind: "patch", vtype: "int", current: (a) => a.unitCount?.toString() ?? "" },
  { key: "yearBuilt", label: "Year built", kind: "patch", vtype: "int", current: (a) => a.yearBuilt?.toString() ?? "" },
  {
    key: "totalInsuredValue",
    label: "Total insured value",
    kind: "patch",
    vtype: "float",
    current: (a) => (a.totalInsuredValue != null ? fmtMoney(a.totalInsuredValue) : ""),
    display: moneyDisplay,
  },
  {
    key: "constructionType",
    label: "Construction type",
    kind: "patch",
    current: (a) => (a.constructionType ? CONSTRUCTION_LABELS[a.constructionType] ?? a.constructionType : ""),
    display: (v) => (typeof v === "string" && v ? CONSTRUCTION_LABELS[v] ?? v : fmtVal(v)),
  },
  { key: "stories", label: "Stories", kind: "patch", vtype: "int", current: (a) => a.stories?.toString() ?? "" },
  { key: "coastal", label: "Coastal", kind: "patch", vtype: "bool", current: (a) => (a.coastal == null ? "" : a.coastal ? "Yes" : "No") },
  { key: "milesToCoast", label: "Miles to coast", kind: "patch", vtype: "float", current: (a) => a.milesToCoast?.toString() ?? "" },
  { key: "roofUpdatedYear", label: "Roof updated", kind: "patch", vtype: "int", current: (a) => a.roofUpdatedYear?.toString() ?? "" },
  { key: "hvacUpdatedYear", label: "HVAC updated", kind: "patch", vtype: "int", current: (a) => a.hvacUpdatedYear?.toString() ?? "" },
  { key: "electricalUpdatedYear", label: "Electrical updated", kind: "patch", vtype: "int", current: (a) => a.electricalUpdatedYear?.toString() ?? "" },
  { key: "plumbingUpdatedYear", label: "Plumbing updated", kind: "patch", vtype: "int", current: (a) => a.plumbingUpdatedYear?.toString() ?? "" },
  { key: "firewallsVerified", label: "Firewalls verified", kind: "patch", vtype: "bool", current: (a) => (a.firewallsVerified == null ? "" : a.firewallsVerified ? "Yes" : "No") },
  { key: "currentAgent", label: "Current agent / broker", kind: "patch", current: (a) => a.currentAgent ?? "" },
  { key: "currentCarrier", label: "Current carrier → notes", kind: "note", current: () => "" },
  {
    key: "currentAnnualPremium",
    label: "Current premium → notes",
    kind: "note",
    current: () => "",
    display: moneyDisplay,
  },
  {
    key: "currentPolicyExpiration",
    label: "Current policy expiration",
    kind: "patch",
    // Clients renew off their bound policies, so this never applies to them.
    leadOnly: true,
    current: (a) => a.currentPolicyExpiration ?? "",
  },
];

/** Clients renew off bound policies, so lead-only fields drop out entirely. */
const fieldDefsFor = (account: Account): FieldDef[] =>
  account.stage === "CLIENT"
    ? ALL_FIELD_DEFS.filter((d) => !d.leadOnly)
    : ALL_FIELD_DEFS;

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

export default function ExtractionPanel({
  account,
  onChange,
}: {
  account: Account;
  onChange: (a: Account) => void;
}) {
  const [starting, setStarting] = useState(false);
  // `error` now belongs to `start()` alone; `apply()`'s whole lifecycle —
  // in-flight, applied, failed — is the one state machine below.
  const [error, setError] = useState("");
  const applyStatus = useSaveStatus();
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [selectedBuildings, setSelectedBuildings] = useState<Record<number, boolean>>({});
  const [selectedContacts, setSelectedContacts] = useState<Record<number, boolean>>({});
  const [showReview, setShowReview] = useState(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // The account's existing contacts, so a candidate can be classified before
  // it is written. Without this the apply path can only ever create, which is
  // how re-running an extraction duplicates everything it already applied.
  //
  // A separate resource rather than part of the poll: the poll is an interval
  // that deliberately drops most of its successful responses, and this is a
  // plain fetch-per-account. The error is deliberately not surfaced — a failed
  // read leaves every candidate classified as "add", which is what the panel
  // did before contacts existed, and blocking the whole review over it would
  // be worse than the duplicate it prevents.
  const contactsRes = useAsyncResource(
    () =>
      listAllPages((nextToken) =>
        client.models.Contact.list({
          filter: { accountId: { eq: account.id } },
          nextToken,
        })
      ),
    [account.id],
    { initialData: [] as Contact[] }
  );

  /** The stored contact a candidate would land on, if there is one. */
  const matchFor = (c: ExtractedContact): Contact | undefined => {
    const key = contactKey(c);
    return contactsRes.data.find((e) => e.extractionSourceKey === key);
  };

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
    for (const def of fieldDefsFor(account)) {
      const f = result[def.key] as ExtractedField | undefined;
      if (f && !isEmpty(f.value)) initial[def.key] = f.confidence !== "low";
    }
    setSelected(initial);
    const b: Record<number, boolean> = {};
    (result.buildings ?? []).forEach((bd, i) => {
      if (bd && (!isEmpty(bd.label as never) || !isEmpty(bd.sqft as never))) b[i] = true;
    });
    setSelectedBuildings(b);
    const c: Record<number, boolean> = {};
    (result.contacts ?? []).forEach((ct, i) => {
      if (namedContact(ct)) c[i] = true;
    });
    setSelectedContacts(c);
    // A fresh extraction means the previous "Applied" no longer describes
    // what is on screen — the same event the form setters signal elsewhere.
    applyStatus.markDirty();
    setShowReview(true); // expand on a fresh extraction
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    await applyStatus.run(
      async () => {
        const patch: Record<string, unknown> = {};
        const noteLines: string[] = [];
        for (const def of fieldDefsFor(account)) {
          if (!selected[def.key]) continue;
          const f = result[def.key] as ExtractedField | undefined;
          if (!f || isEmpty(f.value)) continue;
          const coerced = coerce(def, f.value);
          if (coerced === undefined) continue;
          if (def.kind === "patch") {
            patch[def.key] = coerced;
          } else {
            const shown = def.display ? def.display(f.value) : String(coerced);
            noteLines.push(`${def.label.replace(" → notes", "")}: ${shown}`);
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

        // Contacts before buildings, and match-then-write rather than always
        // create. Re-running an extraction and applying it again used to add
        // a second copy of everything it had already added; a candidate that
        // matches a stored contact on its natural key now updates that row.
        //
        // The update is a *merge*: only fields the documents actually
        // supported are sent. A candidate found in a budget that names the
        // manager but not their phone number must not blank the phone number
        // somebody typed in by hand.
        let contactFailures = 0;
        let primaryTaken = contactsRes.data.some((c) => c.isPrimary);
        for (const c of (result.contacts ?? []).filter((_, i) => selectedContacts[i])) {
          if (!namedContact(c)) continue;
          const found = matchFor(c);
          const name = str(c.name);
          const email = str(c.email);
          const phone = str(c.phone);
          const type = str(c.type) as Contact["type"];
          if (!name) continue;
          const supplied = {
            name,
            ...(email ? { email } : {}),
            ...(phone ? { phone } : {}),
            ...(type ? { type } : {}),
          };
          const written = found
            ? await client.models.Contact.update({ id: found.id, ...supplied })
            : await client.models.Contact.create({
                accountId: account.id,
                ...supplied,
                // An account with nobody flagged has no answer for the ACORD
                // insured block, so the first contact to exist takes it.
                isPrimary: !primaryTaken,
                extractionSourceKey: contactKey(c),
              });
          if (written.errors?.length || !written.data) contactFailures++;
          else if (!found) primaryTaken = true;
        }
        // So a second apply in the same session classifies against what the
        // first one wrote, rather than re-creating it.
        if (result.contacts?.length) await contactsRes.refetch();

        const buildings = (result.buildings ?? []).filter((_, i) => selectedBuildings[i]);
        // These `errors` used to be dropped entirely, so a building that
        // failed to create reported the same green "Applied" as one that did.
        // The account fields did land, so this is a partial success, not a
        // failure: it comes back as `run`'s warning, not a throw.
        let buildingFailures = 0;
        for (const [i, b] of buildings.entries()) {
          const sqftNum = Math.round(Number(String(b.sqft ?? "").replace(/[^0-9.]/g, "")));
          const { data: made, errors: bErrors } = await client.models.Building.create({
            accountId: account.id,
            label: (b.label as string) || `Building ${i + 1}`,
            sqft: Number.isFinite(sqftNum) && sqftNum > 0 ? sqftNum : undefined,
          });
          if (bErrors?.length || !made) buildingFailures++;
        }

        onChange(data);
        // The account fields did land, so a child row that failed is a partial
        // success, not a failure: it comes back as `run`'s warning arm rather
        // than a throw, and it names where to finish the job by hand.
        const unfinished = [
          buildingFailures &&
            `${buildingFailures} building${buildingFailures === 1 ? "" : "s"} under Property`,
          contactFailures &&
            `${contactFailures} contact${contactFailures === 1 ? "" : "s"} on the Contacts card`,
        ].filter(Boolean);
        return unfinished.length
          ? `Fields applied — review the Overview tab. Couldn't save ${unfinished.join(
              " and "
            )}; add ${
              buildingFailures + contactFailures === 1 ? "it" : "them"
            } by hand.`
          : "";
      },
      {
        savedMessage: "Applied — review the Overview tab.",
        errorMessage: "Apply failed",
      }
    );
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

          <button
            className="secondary"
            style={{ marginBottom: showReview ? 10 : 0 }}
            onClick={() => setShowReview((s) => !s)}
          >
            {showReview ? "▾ Hide extracted data" : "▸ Review & apply extracted data"}
          </button>

          {showReview && (
          <>
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
                {fieldDefsFor(account).map((def) => {
                  const f = result[def.key] as ExtractedField | undefined;
                  if (!f || isEmpty(f.value)) return null;
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
                        <Badge {...statusBadge(CONFIDENCE_BADGE, f.confidence)} />
                      </td>
                      <td className="small muted" style={{ maxWidth: 320 }}>
                        {f.evidence ?? "—"}
                        {f.source && <div>({f.source})</div>}
                      </td>
                    </tr>
                  );
                })}
                {(result.contacts ?? []).map((c, i) => {
                  if (!namedContact(c)) return null;
                  const found = matchFor(c);
                  const bits = [
                    c.type ? CONTACT_TYPE_LABELS[c.type] ?? c.type : "",
                    c.email?.trim(),
                    c.phone?.trim() ? fmtPhone(c.phone) : "",
                  ].filter(Boolean);
                  return (
                    <tr key={`c-${i}`}>
                      <td>
                        <input
                          type="checkbox"
                          checked={!!selectedContacts[i]}
                          onChange={(e) =>
                            setSelectedContacts((s) => ({ ...s, [i]: e.target.checked }))
                          }
                        />
                      </td>
                      <td>Contact</td>
                      <td className="small muted">
                        {found
                          ? [found.name, found.email, fmtPhone(found.phone)]
                              .filter((v) => v && v !== "—")
                              .join(" · ")
                          : "—"}
                      </td>
                      <td>
                        <strong>{c.name?.trim()}</strong>
                        {bits.length ? (
                          <div className="small muted">{bits.join(" · ")}</div>
                        ) : null}
                      </td>
                      <td>
                        {/* The verdict, not a confidence: the model does not
                            score a whole person, and what the reviewer needs
                            to know is whether this creates a row or edits one.
                            W9 turns this into the full three-way rule. */}
                        <span className="badge gray">{found ? "update" : "add"}</span>
                      </td>
                      <td className="small muted">
                        {found
                          ? "Updates the matching contact; blank fields are left alone"
                          : "Creates a Contact record"}
                      </td>
                    </tr>
                  );
                })}
                {(result.buildings ?? []).map((b, i) => {
                  const sqftNum = Number(String(b.sqft ?? "").replace(/[^0-9.]/g, ""));
                  const hasSqft = Number.isFinite(sqftNum) && sqftNum > 0;
                  if (isEmpty(b.label as never) && !hasSqft) return null;
                  return (
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
                        {(b.label as string) || `Building ${i + 1}`}
                        {hasSqft ? ` · ${fmtNum(sqftNum)} sq ft` : ""}
                      </strong>
                    </td>
                    <td>
                      <span className="badge gray">add</span>
                    </td>
                    <td className="small muted">Creates a Building record</td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="form-actions">
            <button className="primary" disabled={applyStatus.busy} onClick={apply}>
              {applyStatus.busy
                ? "Applying…"
                : `Apply selected to ${account.stage === "CLIENT" ? "client" : "lead"}`}
            </button>
            <SaveStatus {...applyStatus.status} />
          </div>
          </>
          )}
        </>
      )}
    </div>
  );
}
