import { useEffect, useMemo, useRef, useState } from "react";
import {
  client,
  fmtDate,
  fmtMoney,
  fmtNum,
  fmtPhone,
  friendlyError,
  listAllPages,
  type Account,
  type Building,
  type Contact,
  type Loss,
} from "../lib/client";
import { Badge, statusBadge, CONFIDENCE_BADGE } from "../lib/badges";
import { CONSTRUCTION_LABELS, CONTACT_TYPE_LABELS } from "../lib/enums";
import { str } from "../lib/formCodec";
import { contactKey, lossKey } from "../lib/extractionKeys";
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

interface ExtractedLoss {
  dateOfLoss?: string | null;
  lineOfBusiness?: string | null;
  typeOfLoss?: string | null;
  description?: string | null;
  claimDate?: string | null;
  amountPaid?: string | null;
  amountReserved?: string | null;
  amountOfLoss?: string | null;
  claimOpen?: string | null;
}

interface ExtractionResult {
  [key: string]: unknown;
  contacts?: ExtractedContact[];
  buildings?: ExtractedBuilding[];
  losses?: ExtractedLoss[];
  summary?: string;
  extractedAt?: string;
  documentCount?: number;
}

interface ExtractedBuilding {
  label?: string | null;
  sqft?: string | number | null;
  yearBuilt?: string | null;
  stories?: string | null;
  constructionType?: string | null;
  roofYear?: string | null;
  heatingYear?: string | null;
  wiringYear?: string | null;
  plumbingYear?: string | null;
}

/** A candidate worth showing: the model returned an entry with a name on it. */
const namedContact = (c: ExtractedContact) => Boolean(c?.name?.trim());

/**
 * A loss the app can actually store: both required columns present.
 *
 * A loss run line with no date or no line of business cannot go on the ACORD
 * 125 — its rows are ordered by date and labelled by line — so a candidate
 * missing either is not shown rather than being offered and then rejected by
 * the model on write.
 */
const usableLoss = (l: ExtractedLoss) =>
  Boolean(l?.dateOfLoss?.trim() && l?.lineOfBusiness?.trim());

/** "Yes"/"No" from the model → the nullable column. Anything else is unknown. */
function yesNo(v: string | null | undefined): boolean | null {
  if (/^y(es)?$/i.test(v ?? "")) return true;
  if (/^n(o)?$/i.test(v ?? "")) return false;
  return null;
}

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

/**
 * A digit string from the model → the integer column, or `null`.
 *
 * The model is asked for digits only and mostly obliges, but "1,985" and
 * "12,000 sq ft" both turn up. Not `formCodec.num`, which returns `null` for
 * both of those by design — this is the tolerant parser for text the model
 * wrote, which is a different job with a different answer.
 */
function digits(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Math.round(Number(String(v).replace(/[^0-9.]/g, "")));
  return Number.isFinite(n) && n > 0 ? n : null;
}
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
  {
    key: "totalInsuredValue",
    label: "Total insured value",
    kind: "patch",
    vtype: "float",
    current: (a) => (a.totalInsuredValue != null ? fmtMoney(a.totalInsuredValue) : ""),
    display: moneyDisplay,
  },
  { key: "coastal", label: "Coastal", kind: "patch", vtype: "bool", current: (a) => (a.coastal == null ? "" : a.coastal ? "Yes" : "No") },
  { key: "milesToCoast", label: "Miles to coast", kind: "patch", vtype: "float", current: (a) => a.milesToCoast?.toString() ?? "" },
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
  const [selectedLosses, setSelectedLosses] = useState<Record<number, boolean>>({});
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

  // Same shape and the same reason as the contacts read: a candidate has to
  // be classified against what exists before it is written, or re-applying an
  // extraction files every loss a second time.
  const lossesRes = useAsyncResource(
    () =>
      listAllPages((nextToken) =>
        client.models.Loss.list({
          filter: { accountId: { eq: account.id } },
          nextToken,
        })
      ),
    [account.id],
    { initialData: [] as Loss[] }
  );

  const lossMatchFor = (l: ExtractedLoss): Loss | undefined => {
    const key = lossKey({ ...l, amountOfLoss: l.amountOfLoss ?? null });
    return lossesRes.data.find((e) => e.extractionSourceKey === key);
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
    const ls: Record<number, boolean> = {};
    (result.losses ?? []).forEach((l, i) => {
      if (usableLoss(l)) ls[i] = true;
    });
    setSelectedLosses(ls);
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

        // Losses, matched before written for the same reason contacts are.
        let lossFailures = 0;
        for (const l of (result.losses ?? []).filter((_, i) => selectedLosses[i])) {
          if (!usableLoss(l)) continue;
          const found = lossMatchFor(l);
          const payload = {
            dateOfLoss: str(l.dateOfLoss) as string,
            lineOfBusiness: str(l.lineOfBusiness) as string,
            ...(str(l.typeOfLoss) ? { typeOfLoss: str(l.typeOfLoss) } : {}),
            ...(str(l.description) ? { description: str(l.description) } : {}),
            ...(str(l.claimDate) ? { claimDate: str(l.claimDate) } : {}),
            ...(digits(l.amountPaid) != null ? { amountPaid: digits(l.amountPaid) } : {}),
            ...(digits(l.amountReserved) != null
              ? { amountReserved: digits(l.amountReserved) }
              : {}),
            ...(digits(l.amountOfLoss) != null
              ? { amountOfLoss: digits(l.amountOfLoss) }
              : {}),
            ...(yesNo(l.claimOpen) != null ? { claimOpen: yesNo(l.claimOpen) } : {}),
          };
          const written = found
            ? await client.models.Loss.update({ id: found.id, ...payload })
            : await client.models.Loss.create({
                accountId: account.id,
                ...payload,
                extractionSourceKey: lossKey({
                  ...l,
                  amountOfLoss: l.amountOfLoss ?? null,
                }),
              });
          if (written.errors?.length || !written.data) lossFailures++;
        }
        if (result.losses?.length) await lossesRes.refetch();

        const buildings = (result.buildings ?? []).filter((_, i) => selectedBuildings[i]);
        // These `errors` used to be dropped entirely, so a building that
        // failed to create reported the same green "Applied" as one that did.
        // The account fields did land, so this is a partial success, not a
        // failure: it comes back as `run`'s warning, not a throw.
        let buildingFailures = 0;
        for (const [i, b] of buildings.entries()) {
          const { data: made, errors: bErrors } = await client.models.Building.create({
            accountId: account.id,
            label: (b.label as string) || `Building ${i + 1}`,
            sqft: digits(b.sqft),
            // The seven construction answers arrive per building now. They
            // used to be flat fields patched onto the Account, which gave a
            // thirteen-building association one year built and one
            // construction class for the whole site.
            yearBuilt: digits(b.yearBuilt),
            stories: digits(b.stories),
            constructionType: (b.constructionType ||
              undefined) as Building["constructionType"],
            roofYear: digits(b.roofYear),
            heatingYear: digits(b.heatingYear),
            wiringYear: digits(b.wiringYear),
            plumbingYear: digits(b.plumbingYear),
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
          lossFailures &&
            `${lossFailures} loss${lossFailures === 1 ? "" : "es"} on the Losses tab`,
        ].filter(Boolean);
        return unfinished.length
          ? `Fields applied — review the Overview tab. Couldn't save ${unfinished.join(
              " and "
            )}; add ${
              buildingFailures + contactFailures + lossFailures === 1 ? "it" : "them"
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
                {(result.losses ?? []).map((l, i) => {
                  if (!usableLoss(l)) return null;
                  const found = lossMatchFor(l);
                  const bits = [
                    l.typeOfLoss?.trim(),
                    digits(l.amountPaid) != null
                      ? `${fmtMoney(digits(l.amountPaid))} paid`
                      : "",
                    digits(l.amountReserved) != null
                      ? `${fmtMoney(digits(l.amountReserved))} reserved`
                      : "",
                    yesNo(l.claimOpen) === true
                      ? "open"
                      : yesNo(l.claimOpen) === false
                        ? "closed"
                        : "",
                  ].filter(Boolean);
                  return (
                    <tr key={`l-${i}`}>
                      <td>
                        <input
                          type="checkbox"
                          checked={!!selectedLosses[i]}
                          onChange={(e) =>
                            setSelectedLosses((s) => ({ ...s, [i]: e.target.checked }))
                          }
                        />
                      </td>
                      <td>Loss</td>
                      <td className="small muted">
                        {found
                          ? `${fmtDate(found.dateOfLoss)} ${found.lineOfBusiness}`
                          : "—"}
                      </td>
                      <td>
                        <strong>
                          {fmtDate(l.dateOfLoss)} · {l.lineOfBusiness}
                        </strong>
                        {bits.length ? (
                          <div className="small muted">{bits.join(" · ")}</div>
                        ) : null}
                      </td>
                      <td>
                        <span className="badge gray">{found ? "update" : "add"}</span>
                      </td>
                      <td className="small muted">
                        {found
                          ? "Updates the matching loss; blank fields are left alone"
                          : "Creates a Loss record"}
                      </td>
                    </tr>
                  );
                })}
                {(result.buildings ?? []).map((b, i) => {
                  const sqftNum = digits(b.sqft);
                  const hasSqft = sqftNum != null;
                  if (isEmpty(b.label as never) && !hasSqft) return null;
                  const detail = [
                    b.yearBuilt && `built ${b.yearBuilt}`,
                    b.stories && `${b.stories} storeys`,
                    b.constructionType
                      ? CONSTRUCTION_LABELS[b.constructionType] ?? b.constructionType
                      : "",
                    b.roofYear && `roof ${b.roofYear}`,
                    b.heatingYear && `heating ${b.heatingYear}`,
                    b.wiringYear && `wiring ${b.wiringYear}`,
                    b.plumbingYear && `plumbing ${b.plumbingYear}`,
                  ].filter(Boolean);
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
                      {detail.length ? (
                        <div className="small muted">{detail.join(" · ")}</div>
                      ) : null}
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
