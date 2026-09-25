import { useMemo, useState } from "react";
import {
  fmtDate,
  licenseHealth,
  type License,
  type UserProfile,
} from "../../lib/client";
import { LICENSE_CLASS_LABELS } from "../../lib/enums";
import { Badge } from "../../lib/badges";
import { useSort, SortTh } from "../../lib/useSort";
import { US_MAP_VIEWBOX, US_STATE_NAMES, US_STATE_PATHS } from "../../lib/usMap";
import { holderLabel } from "./holder";

/**
 * Where we can write, as a map.
 *
 * The same question `StateCoverage` answers in a table, for the times a table
 * is the wrong shape for it: coverage is geographic, and "we are licensed in
 * a ragged band from Maine to Virginia but nothing west of Ohio" is a
 * sentence a map says instantly and a sorted list of two-letter codes never
 * does.
 *
 * Green needs **both** a firm licence and at least one producer licence,
 * because either alone cannot write business. That is the same rule as the
 * coverage table's "Can write?" column and the "N of M states writable" tile,
 * expiry included — an expired licence does not count, exactly as it doesn't
 * there. Three places asking one question have to agree, so the rule is
 * {@link coverageOf} and they all call it.
 *
 * Every state is coloured, not just the ones with a licence on file. A blank
 * state and a red one would be the same fact told two ways, and the blank one
 * reads as "no data" when it means "we cannot write here".
 */

/** A state is writable only with both halves live. */
export function coverageOf(
  state: string,
  firm: License[],
  personal: License[]
): { firm: boolean; producers: boolean } {
  const live = (l: License) =>
    l.state === state && licenseHealth(l).level !== "expired";
  return {
    firm: firm.some(live),
    producers: personal.some(live),
  };
}

/** Why a state is not green, in the words the detail panel uses. */
function gapLabel(c: { firm: boolean; producers: boolean }): string {
  if (c.firm && c.producers) return "Licensed — firm and producer";
  if (c.firm) return "Firm licensed, no active producer";
  if (c.producers) return "Producer licensed, no firm licence";
  return "Not licensed";
}

export default function LicenseMap({
  firm,
  personal,
  profiles,
  canEdit,
  onEdit,
}: {
  /** Unfiltered, deliberately — see `Licensing`. */
  firm: License[];
  personal: License[];
  profiles: UserProfile[];
  canEdit: boolean;
  onEdit: (l: License) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);

  const codes = useMemo(() => Object.keys(US_STATE_PATHS).sort(), []);

  const coverage = useMemo(() => {
    const out: Record<string, { firm: boolean; producers: boolean }> = {};
    for (const c of codes) out[c] = coverageOf(c, firm, personal);
    return out;
  }, [codes, firm, personal]);

  const writable = codes.filter((c) => coverage[c].firm && coverage[c].producers);

  const rows = useMemo(
    () =>
      selected
        ? [...firm, ...personal].filter((l) => l.state === selected)
        : [],
    [selected, firm, personal]
  );

  // Firm licence first, then producers alphabetically — the order the
  // question "can we write here?" is actually answered in.
  //
  // The firm's key is "0" rather than "": `useSort` treats an empty string as
  // a blank and sorts blanks LAST in either direction, so the obvious way to
  // write this puts the firm licence at the bottom of its own table.
  const { sorted, sortKey, dir, toggle } = useSort(
    rows,
    {
      holder: (l) =>
        l.holderType === "FIRM" ? "0" : `1 ${holderLabel(l, profiles)}`,
      number: (l) => l.licenseNumber,
      class: (l) => l.licenseClass,
      expires: (l) => l.expirationDate,
    },
    "holder"
  );

  return (
    <>
      <div className="card">
        <div className="toolbar" style={{ marginTop: 0, alignItems: "flex-start" }}>
          <div>
            <h2 style={{ margin: 0 }}>
              Where we can write{" "}
              <span className="muted small" style={{ fontWeight: 400 }}>
                · {writable.length} of {codes.length} states
              </span>
            </h2>
            <p className="muted small" style={{ margin: "4px 0 0" }}>
              Green needs both an active firm licence <em>and</em> an active
              producer licence — either one alone can't write business. Click a
              state for its records.
            </p>
          </div>
          <div className="grow" />
          <span className="map-key">
            <span className="map-key-swatch is-covered" /> Licensed
            <span className="map-key-swatch is-gap" /> Not licensed
          </span>
        </div>

        <svg
          className="us-map"
          viewBox={US_MAP_VIEWBOX}
          role="group"
          aria-label="US licensing coverage"
        >
          {codes.map((c) => {
            const cov = coverage[c];
            const ok = cov.firm && cov.producers;
            const name = US_STATE_NAMES[c] ?? c;
            return (
              <path
                key={c}
                d={US_STATE_PATHS[c]}
                className={`us-state${ok ? " is-covered" : " is-gap"}${
                  selected === c ? " is-selected" : ""
                }`}
                role="button"
                tabIndex={0}
                // The path is the only thing on screen naming this state, so
                // it carries the whole sentence a screen reader needs — the
                // fill colour is not available to one.
                aria-label={`${name} — ${gapLabel(cov)}`}
                aria-pressed={selected === c}
                onClick={() => setSelected((s) => (s === c ? null : c))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelected((s) => (s === c ? null : c));
                  }
                }}
              >
                <title>{`${name} — ${gapLabel(cov)}`}</title>
              </path>
            );
          })}
        </svg>
      </div>

      {selected && (
        <div className="card">
          <div className="toolbar" style={{ marginTop: 0, alignItems: "flex-start" }}>
            <div>
              <h2 style={{ margin: 0 }}>
                {US_STATE_NAMES[selected] ?? selected}{" "}
                <span className="muted small" style={{ fontWeight: 400 }}>
                  · {gapLabel(coverage[selected])}
                </span>
              </h2>
              <p className="muted small" style={{ margin: "4px 0 0" }}>
                Every licence on file for this state, firm and personal.
              </p>
            </div>
            <div className="grow" />
            <button className="link" onClick={() => setSelected(null)}>
              Close
            </button>
          </div>

          {sorted.length === 0 ? (
            <p className="muted small">
              No licences on file for {US_STATE_NAMES[selected] ?? selected}.
            </p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <SortTh label="Holder" colKey="holder" sortKey={sortKey} dir={dir} onToggle={toggle} />
                    <SortTh label="License #" colKey="number" sortKey={sortKey} dir={dir} onToggle={toggle} />
                    <SortTh label="Class" colKey="class" sortKey={sortKey} dir={dir} onToggle={toggle} />
                    <th>Lines of authority</th>
                    <SortTh label="Expires" colKey="expires" sortKey={sortKey} dir={dir} onToggle={toggle} />
                    <th>Status</th>
                    {canEdit && <th></th>}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((l) => (
                    <tr key={l.id}>
                      <td>
                        {l.holderType === "FIRM" ? (
                          <strong>Firm</strong>
                        ) : (
                          holderLabel(l, profiles)
                        )}
                        {l.residency === "RESIDENT" && (
                          <span className="badge blue" style={{ marginLeft: 6 }}>
                            Resident
                          </span>
                        )}
                      </td>
                      <td style={{ fontVariantNumeric: "tabular-nums" }}>
                        {l.licenseNumber}
                      </td>
                      <td className="small">
                        {l.licenseClass
                          ? LICENSE_CLASS_LABELS[l.licenseClass] ?? l.licenseClass
                          : "—"}
                      </td>
                      <td className="small">
                        {(l.linesOfAuthority ?? []).filter(Boolean).join(", ") || "—"}
                      </td>
                      <td className="small" style={{ whiteSpace: "nowrap" }}>
                        {fmtDate(l.expirationDate)}
                      </td>
                      <td>
                        <Badge {...licenseHealth(l)} />
                      </td>
                      {canEdit && (
                        <td style={{ whiteSpace: "nowrap" }}>
                          {/* Edit but not delete. Finding a wrong expiry from
                              the map and having to go hunt for it in the
                              tables is silly; deleting a licence from a view
                              built for skimming is not a trade worth making. */}
                          <button className="link" onClick={() => onEdit(l)}>
                            Edit
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </>
  );
}
