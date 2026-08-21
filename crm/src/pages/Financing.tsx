import { useState } from "react";
import { useIsAdmin } from "../lib/auth";
import { client } from "../lib/client";
import { SaveStatus, useSaveStatus } from "../components/SaveStatus";
import { usePremiumFinance } from "../lib/premiumFinance/PfContext";
import {
  PF_CONFIG_SHA256,
  PF_JURISDICTIONS,
} from "../lib/premiumFinance/jurisdictions";
import { originationGate } from "../lib/premiumFinance/gate";
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

export default function Financing() {
  const isAdmin = useIsAdmin();
  const pf = usePremiumFinance();
  const flipStatus = useSaveStatus();
  const [confirming, setConfirming] = useState(false);

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
          <p className="muted small">
            {pf.enabled
              ? "Originations are ON. Disabling stops new quotes and agreements immediately; existing loans keep servicing — the gate never touches servicing."
              : "Originations are OFF. Nothing in the module is offered to any account while disabled."}
          </p>
        </div>
      )}

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
                const unverified = !j.maxAprVerified;
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
