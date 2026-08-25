import { useState } from "react";
import { useIsAdmin } from "../lib/auth";
import { client } from "../lib/client";
import { SaveStatus, useSaveStatus } from "../components/SaveStatus";
import {
  PF_CONFIG_SHA256,
  PF_JURISDICTIONS,
} from "../lib/premiumFinance/jurisdictions";
import { defaultReviewBy, isOpinionCurrent, originationGate } from "../lib/premiumFinance/gate";
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

/**
 * The premium-finance module's own page: what the signed jurisdiction file
 * says, and the counsel opinions that unlock conditional states.
 *
 * The enable/disable tile is gone (2026-08-25): the module is always on, so
 * nothing in this app can turn it off. The stored module flag still exists
 * and the Lambdas still check it — three of them as DynamoDB condition
 * expressions on the loan write itself — so the interlock survives the
 * button; it simply has no switch on this screen any more.
 */
export default function Financing() {
  const isAdmin = useIsAdmin();

  return (
    <>
      <h1>Financing</h1>
      <p className="sub">
        In-house premium finance. Eligibility is decided by the signed
        jurisdiction file — the table below is that file, as loaded.
      </p>

      {/* The lending-account card lived here until decision 5 was revised
          (2026-08-23): receipts settle to the premium trust on the one
          Stripe rail, and the split is a ledger fact — the remittance email
          and PfLoanPayment's interest/principal fields — not a bank account.
          AgencySettings.pfLendingAccountName remains in the schema, unused,
          per the additive-only rule. */}
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
                        // unread statute. A badge, not the `.warn-inline`
                        // callout it used to be — that class is a block
                        // element, and inside a table cell it wrapped into
                        // two half-painted boxes with the border stripe on
                        // only the first line. Amber against the row's green
                        // OPEN is the contradiction, stated in the table's
                        // own vocabulary.
                        <Badge cls="amber" label="blocked — ceiling unverified" />
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
