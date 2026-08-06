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
import { buildingKey, contactKey, lossKey } from "../lib/extractionKeys";
import {
  VERDICT_LABEL,
  classifyCandidate,
  type Match,
} from "../lib/extractionMatch";
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

/**
 * A building the app can store: the model gave it a name, a size, or both.
 *
 * An entry with neither is not a building the documents described — it is the
 * model filling an array slot — and offering it would put "Building 3" with
 * nothing in it on the Property tab.
 */
const usableBuilding = (b: ExtractedBuilding) =>
  Boolean(b?.label?.trim()) || digits(b?.sqft) != null;

/** "Yes"/"No" from the model → the nullable column. Anything else is unknown. */
function yesNo(v: string | null | undefined): boolean | null {
  if (/^y(es)?$/i.test(v ?? "")) return true;
  if (/^n(o)?$/i.test(v ?? "")) return false;
  return null;
}

/**
 * What a candidate would be written as: its natural key, and only the columns
 * the documents actually supported.
 *
 * One function per kind, used by both the review table and the apply path, so
 * the verdict a reviewer read is computed from the same payload that is about
 * to be written. Two separate derivations would eventually disagree, and the
 * disagreement would be invisible — the screen saying "no change" over a
 * write that changed something.
 *
 * Absence matters here. A key omitted from `supplied` is a column the
 * documents said nothing about: it is not compared, and it is not written, so
 * a hand-typed phone number survives an extraction that never mentioned one.
 */
interface Write {
  key: string;
  supplied: Record<string, unknown>;
}

/** Drops keys whose value is undefined, which is how "not supplied" is said. */
const given = (o: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

function contactWrite(c: ExtractedContact): Write {
  return {
    key: contactKey(c),
    supplied: given({
      name: str(c.name),
      email: str(c.email),
      phone: str(c.phone),
      type: str(c.type),
    }),
  };
}

function lossWrite(l: ExtractedLoss): Write {
  return {
    key: lossKey({ ...l, amountOfLoss: l.amountOfLoss ?? null }),
    supplied: given({
      dateOfLoss: str(l.dateOfLoss),
      lineOfBusiness: str(l.lineOfBusiness),
      typeOfLoss: str(l.typeOfLoss),
      description: str(l.description),
      claimDate: str(l.claimDate),
      amountPaid: digits(l.amountPaid) ?? undefined,
      amountReserved: digits(l.amountReserved) ?? undefined,
      amountOfLoss: digits(l.amountOfLoss) ?? undefined,
      claimOpen: yesNo(l.claimOpen) ?? undefined,
    }),
  };
}

function buildingWrite(b: ExtractedBuilding, i: number): Write {
  // Named before the key is taken, not after: the row that gets stored says
  // "Building 3", so that is what a later extraction has to match against.
  const label = b.label?.trim() || `Building ${i + 1}`;
  return {
    key: buildingKey({ label }),
    supplied: given({
      label,
      sqft: digits(b.sqft) ?? undefined,
      // The seven construction answers arrive per building. They used to be
      // flat fields patched onto the Account, which gave a thirteen-building
      // association one year built and one construction class for the site.
      yearBuilt: digits(b.yearBuilt) ?? undefined,
      stories: digits(b.stories) ?? undefined,
      constructionType: b.constructionType || undefined,
      roofYear: digits(b.roofYear) ?? undefined,
      heatingYear: digits(b.heatingYear) ?? undefined,
      wiringYear: digits(b.wiringYear) ?? undefined,
      plumbingYear: digits(b.plumbingYear) ?? undefined,
    }),
  };
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

/**
 * One candidate row in the review table, with its verdict.
 *
 * The verdict is not decoration. "add" and "update" are two different writes
 * and a reviewer needs to know which one they are authorising; "no change" is
 * the case that used to produce duplicates, so it is greyed, unticked and
 * cannot be selected — the row is there to say the record already agrees with
 * the documents, which is worth seeing and not worth writing.
 *
 * An "update" also shows what would change, field by field. A checkbox that
 * says only "update" asks somebody to approve an edit without telling them
 * what the edit is.
 */
function CandidateRow<E>({
  kind,
  match,
  checked,
  onToggle,
  current,
  title,
  detail,
}: {
  kind: string;
  match: Match<E>;
  checked: boolean;
  onToggle: (v: boolean) => void;
  /** How the stored row reads today, or "" when there isn't one. */
  current: string;
  title: string;
  /** Sub-line bits; falsy entries are dropped here rather than at each site. */
  detail: (string | false | undefined | null)[];
}) {
  const identical = match.verdict === "identical";
  const bits = detail.filter(Boolean) as string[];
  return (
    <tr style={identical ? { opacity: 0.55 } : undefined}>
      <td>
        <input
          type="checkbox"
          checked={checked && !identical}
          disabled={identical}
          title={identical ? "Already on the record — nothing to write" : undefined}
          onChange={(e) => onToggle(e.target.checked)}
        />
      </td>
      <td>{kind}</td>
      <td className="small muted">{current || "—"}</td>
      <td>
        <strong>{title}</strong>
        {bits.length ? <div className="small muted">{bits.join(" · ")}</div> : null}
      </td>
      <td>
        <span className={`badge ${identical ? "gray" : "blue"}`}>
          {VERDICT_LABEL[match.verdict]}
        </span>
      </td>
      <td className="small muted" style={{ maxWidth: 320 }}>
        {match.verdict === "new" ? (
          `Creates a ${kind} record`
        ) : identical ? (
          "Already matches the record — nothing will be written"
        ) : (
          <>
            Updates the matching {kind.toLowerCase()}:
            <ul style={{ margin: "2px 0 0", paddingLeft: 16 }}>
              {match.changes.map((c) => (
                <li key={c.field}>
                  {fieldLabel(c.field)}: {shownValue(c.from)} → {shownValue(c.to)}
                </li>
              ))}
            </ul>
          </>
        )}
      </td>
    </tr>
  );
}

/** A column name as a person reads it — the same rule the activity log uses. */
const fieldLabel = (f: string) =>
  f.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).trim();

const shownValue = (v: unknown): string => {
  if (v == null || v === "") return "blank";
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
};

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

  const status = account.extractionStatus;
  const result = useMemo(
    () => parseExtraction(account.aiExtraction),
    [account.aiExtraction]
  );

  /**
   * This exact extraction has already been applied.
   *
   * `aiExtractionAppliedAt` stores the applied result's `extractedAt` — the
   * identity of a result, not the moment somebody pressed the button — so
   * this is true only until a re-run produces a different one. A result with
   * no `extractedAt` (nothing in the app writes one, but an old row might)
   * cannot be proved to be the same, so it is treated as unapplied.
   */
  const alreadyApplied = Boolean(
    result?.extractedAt && result.extractedAt === account.aiExtractionAppliedAt
  );

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

  // Buildings were the original bug: they were created unconditionally on
  // every apply, so a re-run duplicated the whole property schedule.
  const buildingsRes = useAsyncResource(
    () =>
      listAllPages((nextToken) =>
        client.models.Building.list({
          filter: { accountId: { eq: account.id } },
          nextToken,
        })
      ),
    [account.id],
    { initialData: [] as Building[] }
  );

  /**
   * Every candidate the panel will show, already classified.
   *
   * Computed once here rather than per row, because the review table and the
   * apply path must not disagree about what a candidate is: the checkbox a
   * reviewer ticked and the write it authorises come from the same object.
   */
  const contactCandidates = useMemo(
    () =>
      (result?.contacts ?? [])
        .map((c, i) => ({ i, row: c, ...contactWrite(c) }))
        .filter((x) => namedContact(x.row))
        .map((x) => ({
          ...x,
          match: classifyCandidate(x.key, x.supplied, contactsRes.data),
        })),
    [result, contactsRes.data]
  );

  const lossCandidates = useMemo(
    () =>
      (result?.losses ?? [])
        .map((l, i) => ({ i, row: l, ...lossWrite(l) }))
        .filter((x) => usableLoss(x.row))
        .map((x) => ({
          ...x,
          match: classifyCandidate(x.key, x.supplied, lossesRes.data),
        })),
    [result, lossesRes.data]
  );

  const buildingCandidates = useMemo(
    () =>
      (result?.buildings ?? [])
        .map((b, i) => ({ i, row: b, ...buildingWrite(b, i) }))
        .filter((x) => usableBuilding(x.row))
        .map((x) => ({
          ...x,
          match: classifyCandidate(x.key, x.supplied, buildingsRes.data),
        })),
    [result, buildingsRes.data]
  );

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
    // Selection is set from the candidate alone, never from its verdict: the
    // existing rows load asynchronously, so a verdict computed here would be
    // whatever it happened to be before the reads settled. "Identical" is
    // enforced at render and at apply instead, where the answer is current.
    const b: Record<number, boolean> = {};
    (result.buildings ?? []).forEach((bd, i) => {
      if (usableBuilding(bd)) b[i] = true;
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

  /**
   * @param force set by "Apply again anyway", the only way past the
   *   idempotency guard. A parameter rather than a piece of state so the
   *   guard cannot be left switched off by a click three minutes ago.
   */
  async function apply(force = false) {
    if (!result) return;
    await applyStatus.run(
      async () => {
        // The idempotency rule. Match-then-write already makes a second apply
        // harmless row by row, but "harmless" is not the same as "did
        // nothing": it still writes the account patch, still bumps every
        // matched row's updatedAt, and still fills the activity log with
        // edits nobody made.
        //
        // The button stays enabled and this returns a message, rather than
        // the button being disabled: a disabled control says "no" without
        // saying why, and the spec asks for an explicit no-op, not a dead
        // button. This is also the only place the rule is enforced — there is
        // no second copy of it in the JSX to disagree with.
        if (alreadyApplied && !force) {
          return "This extraction has already been applied, so nothing was written. Re-run the extraction to pick up new documents, or use “Apply again anyway” to write it a second time.";
        }

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
          // Marks *this* result as applied. Written with the patch rather
          // than after the child rows, so a run that fails partway through
          // still records that it happened — a second attempt then reports
          // "already applied" instead of silently re-writing the half that
          // did land.
          ...(result.extractedAt ? { aiExtractionAppliedAt: result.extractedAt } : {}),
        });
        if (errors?.length || !data) throw new Error(errors?.[0]?.message);

        // Contacts, losses and buildings all follow the same rule now: match
        // on the natural key, then create, update, or do nothing. Buildings
        // were the original bug — they were created unconditionally, so a
        // re-run duplicated the whole property schedule.
        //
        // An update is a *merge*: only fields the documents actually
        // supported are sent. A candidate found in a budget that names the
        // manager but not their phone number must not blank the phone number
        // somebody typed in by hand.
        let contactFailures = 0;
        let unchanged = 0;
        let primaryTaken = contactsRes.data.some((c) => c.isPrimary);
        for (const c of contactCandidates) {
          if (!selectedContacts[c.i]) continue;
          if (c.match.verdict === "identical") {
            unchanged++;
            continue;
          }
          if (!c.supplied.name) continue;
          const written = c.match.existing
            ? await client.models.Contact.update({
                id: c.match.existing.id,
                ...c.supplied,
              })
            : await client.models.Contact.create({
                accountId: account.id,
                ...(c.supplied as Partial<Contact>),
                name: c.supplied.name as string,
                // An account with nobody flagged has no answer for the ACORD
                // insured block, so the first contact to exist takes it.
                isPrimary: !primaryTaken,
                extractionSourceKey: c.key,
              });
          if (written.errors?.length || !written.data) contactFailures++;
          else if (!c.match.existing) primaryTaken = true;
        }
        // So a second apply in the same session classifies against what the
        // first one wrote, rather than re-creating it.
        if (contactCandidates.length) await contactsRes.refetch();

        let lossFailures = 0;
        for (const l of lossCandidates) {
          if (!selectedLosses[l.i]) continue;
          if (l.match.verdict === "identical") {
            unchanged++;
            continue;
          }
          const written = l.match.existing
            ? await client.models.Loss.update({
                id: l.match.existing.id,
                ...l.supplied,
              })
            : await client.models.Loss.create({
                accountId: account.id,
                ...(l.supplied as Partial<Loss>),
                dateOfLoss: l.supplied.dateOfLoss as string,
                lineOfBusiness: l.supplied.lineOfBusiness as string,
                extractionSourceKey: l.key,
              });
          if (written.errors?.length || !written.data) lossFailures++;
        }
        if (lossCandidates.length) await lossesRes.refetch();

        // These `errors` used to be dropped entirely, so a building that
        // failed to create reported the same green "Applied" as one that did.
        // The account fields did land, so this is a partial success, not a
        // failure: it comes back as `run`'s warning, not a throw.
        let buildingFailures = 0;
        for (const b of buildingCandidates) {
          if (!selectedBuildings[b.i]) continue;
          if (b.match.verdict === "identical") {
            unchanged++;
            continue;
          }
          const written = b.match.existing
            ? await client.models.Building.update({
                id: b.match.existing.id,
                ...b.supplied,
              })
            : await client.models.Building.create({
                accountId: account.id,
                ...(b.supplied as Partial<Building>),
                extractionSourceKey: b.key,
              });
          if (written.errors?.length || !written.data) buildingFailures++;
        }
        if (buildingCandidates.length) await buildingsRes.refetch();

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
        if (unfinished.length) {
          return `Fields applied — review the Overview tab. Couldn't save ${unfinished.join(
            " and "
          )}; add ${
            buildingFailures + contactFailures + lossFailures === 1 ? "it" : "them"
          } by hand.`;
        }
        // Not a warning — nothing needs acting on — but worth saying out
        // loud. A reviewer who ticked eight rows and got a bare "Applied"
        // has no way to tell that six of them were already on the record.
        return unchanged
          ? `Applied — review the Overview tab. ${unchanged} selected row${
              unchanged === 1 ? " was" : "s were"
            } already on the record and left alone.`
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
                {contactCandidates.map(({ i, row: c, match }) => {
                  const found = match.existing;
                  const bits = [
                    c.type ? CONTACT_TYPE_LABELS[c.type] ?? c.type : "",
                    c.email?.trim(),
                    c.phone?.trim() ? fmtPhone(c.phone) : "",
                  ].filter(Boolean);
                  return (
                    <CandidateRow
                      key={`c-${i}`}
                      kind="Contact"
                      match={match}
                      checked={!!selectedContacts[i]}
                      onToggle={(v) =>
                        setSelectedContacts((s) => ({ ...s, [i]: v }))
                      }
                      current={
                        found
                          ? [found.name, found.email, fmtPhone(found.phone)]
                              .filter((v) => v && v !== "—")
                              .join(" · ")
                          : ""
                      }
                      title={c.name?.trim() ?? ""}
                      detail={bits}
                    />
                  );
                })}
                {lossCandidates.map(({ i, row: l, match }) => {
                  const found = match.existing;
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
                    <CandidateRow
                      key={`l-${i}`}
                      kind="Loss"
                      match={match}
                      checked={!!selectedLosses[i]}
                      onToggle={(v) => setSelectedLosses((s) => ({ ...s, [i]: v }))}
                      current={
                        found
                          ? `${fmtDate(found.dateOfLoss)} ${found.lineOfBusiness}`
                          : ""
                      }
                      title={`${fmtDate(l.dateOfLoss)} · ${l.lineOfBusiness}`}
                      detail={bits}
                    />
                  );
                })}
                {buildingCandidates.map(({ i, row: b, match }) => {
                  const sqftNum = digits(b.sqft);
                  const hasSqft = sqftNum != null;
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
                  const found = match.existing;
                  return (
                    <CandidateRow
                      key={`b-${i}`}
                      kind="Building"
                      match={match}
                      checked={!!selectedBuildings[i]}
                      onToggle={(v) =>
                        setSelectedBuildings((s) => ({ ...s, [i]: v }))
                      }
                      current={
                        found
                          ? [found.label, found.sqft ? `${fmtNum(found.sqft)} sq ft` : ""]
                              .filter(Boolean)
                              .join(" · ")
                          : ""
                      }
                      title={`${b.label?.trim() || `Building ${i + 1}`}${
                        hasSqft ? ` · ${fmtNum(sqftNum)} sq ft` : ""
                      }`}
                      detail={detail}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="form-actions">
            <button
              className="primary"
              disabled={applyStatus.busy}
              onClick={() => apply()}
            >
              {applyStatus.busy
                ? "Applying…"
                : `Apply selected to ${account.stage === "CLIENT" ? "client" : "lead"}`}
            </button>
            {/* The guard is a default, not a wall. A reviewer who has since
                ticked a field they skipped the first time has a legitimate
                reason to apply the same result again, and blocking that
                outright would send them to edit the record by hand. */}
            {alreadyApplied && (
              <button
                className="link"
                disabled={applyStatus.busy}
                onClick={() => apply(true)}
              >
                Apply again anyway
              </button>
            )}
            <SaveStatus {...applyStatus.status} />
          </div>
          </>
          )}
        </>
      )}
    </div>
  );
}
