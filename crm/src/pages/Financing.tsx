import { useState } from "react";
import { useIsAdmin } from "../lib/auth";
import { client } from "../lib/client";
import { SaveStatus, useSaveStatus } from "../components/SaveStatus";
import { usePremiumFinance } from "../lib/premiumFinance/PfContext";
import {
  PF_CONFIG_SHA256,
  PF_JURISDICTIONS,
} from "../lib/premiumFinance/jurisdictions";
import { defaultReviewBy, isOpinionCurrent, originationGate } from "../lib/premiumFinance/gate";
import { AGENCY_SETTINGS_ID } from "../lib/agencySettings";
import { useAsyncResource } from "../lib/useAsyncResource";
import type { Schema } from "../../amplify/data/resource";

type PfCounselOpinion = Schema["PfCounselOpinion"]["type"];
import { Badge, type BadgeSpec } from "../lib/badges";

/**
 * The premium-finance module's home: the jurisdiction table as the running
 * code actually loaded it, and the kill switch.
 *
 * The table is rendered from the same generated module every gate reads — not
 * re-fetched, not re-parsed — so what this page shows IS what the gate does.
 * The SHA at the top is the hash of the signed YAML the module was generated
 * from: compare it to the signed file's hash and you know what production is
 * running without diffing anything.
 */

const STATUS_BADGE: Record<string, BadgeSpec> = {
  open: { cls: "green", label: "OPEN" },
  conditional: { cls: "amber", label: "CONDITIONAL" },
  closed: { cls: "gray", label: "CLOSED" },
};

/**
 * The designated lending bank account's label — the segregation rule as a
 * required setting. Payment posting refuses until it names an account, and
 * it must never name the premium trust: fiduciary premium and lending
 * capital cannot commingle.
 */
function LendingAccountCard() {
  const status = useSaveStatus({ autoClearMs: 4000 });
  const [name, setName] = useState<string | null>(null);
  const loaded = useAsyncResource(
    async () => {
      const { data } = await client.models.AgencySettings.get({ id: AGENCY_SETTINGS_ID });
      return data?.pfLendingAccountName ?? "";
    },
    [],
    { initialData: null }
  );
  const value = name ?? loaded.data ?? "";

  async function save() {
    await status.run(
      async () => {
        const { data: existing } = await client.models.AgencySettings.get({
          id: AGENCY_SETTINGS_ID,
        });
        const patch = { pfLendingAccountName: value.trim() || null };
        const { errors } = existing
          ? await client.models.AgencySettings.update({ id: AGENCY_SETTINGS_ID, ...patch })
          : await client.models.AgencySettings.create({ id: AGENCY_SETTINGS_ID, ...patch });
        if (errors?.length) throw new Error(errors[0].message);
        return "Saved.";
      },
      { errorMessage: "Couldn't save the account name." }
    );
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>Lending account</h2>
        <SaveStatus {...status.status} />
      </div>
      <p className="muted small">
        Every loan receipt and disbursement references this account, and it
        must not be the premium trust — fiduciary premium and lending capital
        cannot commingle. Payment posting refuses until this is set.
      </p>
      <div className="inline-actions">
        <div className="field" style={{ minWidth: 320 }}>
          <label htmlFor="pf-lending-acct">Designated lending account (label)</label>
          <input
            id="pf-lending-acct"
            placeholder='e.g. "Operating — Lending, Rockland Trust x4821"'
            value={value}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <button type="button" className="secondary" disabled={status.busy} onClick={() => void save()}>
          Save
        </button>
      </div>
    </div>
  );
}

/**
 * Counsel opinions unlock conditional jurisdictions — and expire. Rows are
 * permanent: superseding is a new row, and past `reviewBy` the jurisdiction
 * reverts to blocked with "opinion past review" (decision D).
 */
function CounselOpinionsCard() {
  const status = useSaveStatus({ autoClearMs: 4000 });
  const conditional = PF_JURISDICTIONS.filter((j) => j.status === "conditional");
  const [code, setCode] = useState("");
  const [effectiveAt, setEffectiveAt] = useState("");
  const [reviewBy, setReviewBy] = useState("");
  const [notes, setNotes] = useState("");
  const rows = useAsyncResource(
    async () => {
      const { data } = await client.models.PfCounselOpinion.list({ limit: 200 });
      return data as PfCounselOpinion[];
    },
    [],
    { initialData: [] as PfCounselOpinion[] }
  );
  const today = new Date().toISOString().slice(0, 10);

  async function add() {
    await status.run(
      async () => {
        const { errors } = await client.models.PfCounselOpinion.create({
          jurisdiction: code,
          effectiveAt,
          reviewBy: reviewBy || defaultReviewBy(effectiveAt),
          notes: notes.trim() || null,
          occurredAt: new Date().toISOString(),
        });
        if (errors?.length) throw new Error(errors[0].message);
        setCode("");
        setEffectiveAt("");
        setReviewBy("");
        setNotes("");
        await rows.refetch();
        return "Opinion recorded.";
      },
      { errorMessage: "Couldn't record the opinion." }
    );
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>Counsel opinions</h2>
        <SaveStatus {...status.status} />
      </div>
      <p className="muted small">
        A conditional jurisdiction stays blocked until a signed opinion is on
        file and within its review date. Upload the signed PDF to the
        account-independent Documents area and record it here; the default
        review horizon is 24 months.
      </p>
      {rows.data.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Jurisdiction</th>
                <th>Effective</th>
                <th>Review by</th>
                <th>Status</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {rows.data.map((o) => (
                <tr key={o.id}>
                  <td>{o.jurisdiction}</td>
                  <td>{o.effectiveAt}</td>
                  <td>{o.reviewBy}</td>
                  <td>
                    {isOpinionCurrent(
                      { effectiveAt: o.effectiveAt, reviewBy: o.reviewBy },
                      today
                    ) ? (
                      <span className="badge green">CURRENT</span>
                    ) : (
                      <span className="badge amber">PAST REVIEW</span>
                    )}
                  </td>
                  <td className="small muted">{o.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="form-grid">
        <div className="field">
          <label>Jurisdiction</label>
          <select value={code} onChange={(e) => setCode(e.target.value)}>
            <option value="">Choose…</option>
            {conditional.map((j) => (
              <option key={j.code} value={j.code}>
                {j.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Effective</label>
          <input
            type="date"
            value={effectiveAt}
            onChange={(e) => {
              setEffectiveAt(e.target.value);
              if (e.target.value && !reviewBy) setReviewBy(defaultReviewBy(e.target.value));
            }}
          />
        </div>
        <div className="field">
          <label>Review by</label>
          <input type="date" value={reviewBy} onChange={(e) => setReviewBy(e.target.value)} />
        </div>
        <div className="field">
          <label>Notes</label>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>
      <div className="inline-actions">
        <button
          type="button"
          className="secondary"
          disabled={!code || !effectiveAt || status.busy}
          onClick={() => void add()}
        >
          Record opinion
        </button>
      </div>
    </div>
  );
}

export default function Financing() {
  const isAdmin = useIsAdmin();
  const pf = usePremiumFinance();
  const flipStatus = useSaveStatus();
  const [confirming, setConfirming] = useState(false);
  const [flipWarning, setFlipWarning] = useState<string | null>(null);

  async function flip(enabled: boolean) {
    setConfirming(false);
    await flipStatus.run(
      async () => {
        const { data, errors } = await client.mutations.setPremiumFinanceEnabled({
          enabled,
        });
        if (errors?.length) throw new Error(errors[0].message);
        // AWSJSON arrives as a string — the lib/aiExtraction.ts trap.
        const result =
          typeof data === "string" ? JSON.parse(data) : (data as Record<string, unknown>);
        if (!result?.ok) throw new Error(String(result?.error ?? "Flip failed."));
        // The disable path can succeed with an unlogged flip — the module is
        // off (that always wins) but someone must record it by hand. Loud.
        setFlipWarning(typeof result.warning === "string" ? result.warning : null);
        await pf.refresh();
        return enabled ? "Module enabled. Logged." : "Module disabled. Logged.";
      },
      { errorMessage: "Couldn't change the setting." }
    );
  }

  if (!pf.loaded) return <p className="muted">Loading…</p>;

  if (!pf.enabled && !isAdmin) {
    return (
      <>
        <h1>Financing</h1>
        <p className="muted">Premium financing is not enabled.</p>
      </>
    );
  }

  return (
    <>
      <h1>Financing</h1>
      <p className="sub">
        In-house premium finance. Eligibility is decided by the signed
        jurisdiction file — the table below is that file, as loaded.
      </p>

      {isAdmin && (
        <div className="card">
          <div className="card-head">
            <h2>Module</h2>
            <div className="inline-actions">
              <SaveStatus {...flipStatus.status} />
              {!confirming ? (
                <button
                  type="button"
                  className={pf.enabled ? "danger" : "primary"}
                  disabled={flipStatus.busy}
                  onClick={() => setConfirming(true)}
                >
                  {pf.enabled ? "Disable module" : "Enable module"}
                </button>
              ) : (
                <>
                  <span className="muted small">
                    The flip is logged with your name.
                  </span>
                  <button
                    type="button"
                    className={pf.enabled ? "danger" : "primary"}
                    disabled={flipStatus.busy}
                    onClick={() => void flip(!pf.enabled)}
                  >
                    Confirm {pf.enabled ? "disable" : "enable"}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setConfirming(false)}
                  >
                    Cancel
                  </button>
                </>
              )}
            </div>
          </div>
          {flipWarning && <p className="warn-inline">{flipWarning}</p>}
          <p className="muted small">
            {pf.enabled
              ? "Originations are ON. Disabling stops new quotes and agreements immediately; existing loans keep servicing — the gate never touches servicing."
              : "Originations are OFF. Nothing in the module is offered to any account while disabled."}
          </p>
        </div>
      )}

      {isAdmin && <LendingAccountCard />}
      {isAdmin && <CounselOpinionsCard />}

      <div className="card">
        <div className="card-head">
          <h2>Jurisdictions</h2>
          <p className="muted small">
            Signed file SHA-256: <code>{PF_CONFIG_SHA256.slice(0, 16)}…</code>
          </p>
        </div>
        <p className="muted small">
          Status comes from the signed compliance file, not from this app's
          code. An unverified rate ceiling behaves as closed whatever the
          status column says.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Jurisdiction</th>
                <th>Status</th>
                <th>In effect</th>
                <th className="num">Max APR</th>
                <th className="num">Min principal</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {PF_JURISDICTIONS.map((j) => {
                const gate = originationGate(j.code);
                // Explicitly false only: closed rows carry null ("not
                // applicable"), which is not the alarm state.
                const unverified = j.maxAprVerified === false;
                return (
                  <tr key={j.code}>
                    <td>
                      {j.name} <span className="muted small">{j.code}</span>
                    </td>
                    <td>
                      <Badge {...(STATUS_BADGE[j.status] ?? STATUS_BADGE.closed)} />
                    </td>
                    <td>
                      {unverified ? (
                        // The row that must not be glanced past: status says
                        // open, behavior is closed, and the difference is an
                        // unread statute.
                        <span className="warn-inline">
                          ceiling unverified — behaves as CLOSED
                        </span>
                      ) : gate.open ? (
                        <span className="small">open</span>
                      ) : (
                        <span className="muted small">blocked</span>
                      )}
                    </td>
                    <td className="num">
                      {j.maxApr === null ? <span className="muted">none</span> : `${j.maxApr}%`}
                    </td>
                    <td className="num">
                      {j.minPrincipal === null ? (
                        <span className="muted">—</span>
                      ) : (
                        `$${j.minPrincipal.toLocaleString("en-US")}`
                      )}
                    </td>
                    <td className="small muted">{j.note}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
