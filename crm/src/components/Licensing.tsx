import { Suspense, lazy, useMemo, useState } from "react";
import {
  client,
  licenseHealth,
  type License,
  type UserProfile,
} from "../lib/client";
import { useAsyncResource } from "../lib/useAsyncResource";
import { useIsAdmin } from "../lib/auth";
import Modal from "./Modal";
import { holderLabel, type HolderType } from "./licensing/holder";
import LegacyBackfill from "./licensing/LegacyBackfill";
import LicenseTable from "./licensing/LicenseTable";
import LicenseForm from "./licensing/LicenseForm";
import StateCoverage from "./licensing/StateCoverage";

/**
 * Lazy because of what it drags in: `usMap.ts` is 78KB of Census outlines,
 * and the app ships one bundle. Loading that for everyone who opens Settings
 * to change their signature would be paying for a map on every page.
 *
 * Still worth it now that the map is this tab's default view: Licensing is
 * one of Settings' four tabs, so the other three — and every other screen in
 * the app — still never fetch the chunk.
 */
const LicenseMap = lazy(() => import("./licensing/LicenseMap"));

/**
 * Firm + personal licensing.
 *
 * Both kinds live in one License table separated by holderType, so renewal
 * tracking, document attachment and the state-coverage matrix are written
 * once. Supporting files (the license PDF, renewal receipts, CE certificates)
 * attach per-license as Documents with entityType=LICENSE.
 *
 * Two views over the same rows. The tables are for working through licences
 * one at a time — filter, sort, edit, attach the renewal receipt. The map is
 * for the question the tables answer badly, which is where the gaps are.
 */
/**
 * One view on screen at a time.
 *
 * These used to be two: "map", and a "tables" that stacked the firm table, the
 * personal table and the coverage matrix into a single column. Past a hundred
 * licences of each that is thousands of pixels of scroll to reach the third
 * thing, and the two tables answer different questions — nobody reads both at
 * once. Splitting them costs one click and removes the scroll entirely.
 */
const VIEWS = [
  { key: "map", label: "Map" },
  { key: "firm", label: "Firm" },
  { key: "people", label: "People" },
  { key: "coverage", label: "Coverage" },
] as const;

type View = (typeof VIEWS)[number]["key"];

export default function Licensing() {
  // Map first. Opening this screen is usually prompted by "can we write this
  // one?" rather than by a particular licence, and that is the question the
  // map answers in a glance and the tables answer only after you have read
  // three of them.
  const [view, setView] = useState<View>("map");
  const [adding, setAdding] = useState<HolderType | null>(null);
  const [editing, setEditing] = useState<License | null>(null);
  const [openDocsFor, setOpenDocsFor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [attentionOnly, setAttentionOnly] = useState(false);

  const isAdmin = useIsAdmin();

  // Two hooks rather than one `{licenses, profiles}` fetcher: this screen
  // never refetches, it patches `licenses` locally in three places (delete,
  // append after backfill, upsert after save), and those stay one-liners only
  // while `licenses` is its own resource. The single loading gate the two
  // reads shared is reproduced below by OR-ing the two flags.
  const lic = useAsyncResource(
    async () => (await client.models.License.list()).data,
    [],
    { initialData: [] as License[], errorMessage: "Failed to load licenses" }
  );
  const prof = useAsyncResource(
    async () => (await client.models.UserProfile.list()).data,
    [],
    { initialData: [] as UserProfile[], errorMessage: "Failed to load team profiles" }
  );
  const licenses = lic.data;
  const setLicenses = lic.setData;
  const profiles = prof.data;
  const loading = lic.loading || prof.loading;
  // The profiles read is secondary but not ignorable — without it personal
  // licences lose their holder name, the holder filter stops matching, and
  // the form can't pick a producer. It shares the page's one error slot.
  const error = lic.error || prof.error;

  const allFirm = licenses.filter((l) => l.holderType === "FIRM");
  const allPersonal = licenses.filter((l) => l.holderType === "PRODUCER");

  /**
   * One filter drives every section below. At 30+ licenses per producer,
   * scanning is the bottleneck — typing "NH" should collapse the whole page
   * to New Hampshire rather than making you hunt through three tables.
   */
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (l: License) => {
      if (attentionOnly) {
        const lvl = licenseHealth(l).level;
        if (lvl !== "expired" && lvl !== "urgent" && lvl !== "soon") return false;
      }
      if (!q) return true;
      return [
        l.state,
        l.licenseNumber,
        l.npn,
        holderLabel(l, profiles),
        l.licenseClass,
        (l.linesOfAuthority ?? []).filter(Boolean).join(" "),
      ]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    };
  }, [query, attentionOnly, profiles]);

  const firm = allFirm.filter(matches);
  const personal = allPersonal.filter(matches);
  const filtering = query.trim().length > 0 || attentionOnly;

  /**
   * Scoped to the table on screen. Summing both tables would name a total that
   * isn't in front of you — "showing 30 of 214" over a firm table holding 8.
   */
  const counts =
    view === "firm"
      ? { shown: firm.length, total: allFirm.length, noun: "firm licenses" }
      : view === "people"
        ? { shown: personal.length, total: allPersonal.length, noun: "personal licenses" }
        : {
            shown: firm.length + personal.length,
            total: allFirm.length + allPersonal.length,
            noun: "licenses",
          };

  // Compliance roll-up: expired, inactive, or expiring within 60 days.
  const attentionCount = useMemo(
    () =>
      licenses.filter((l) => {
        const lvl = licenseHealth(l).level;
        return lvl === "expired" || lvl === "urgent" || lvl === "soon";
      }).length,
    [licenses]
  );

  // How many states we can actually write in: firm licensed AND a producer
  // licensed, both unexpired. Counted over every state that appears anywhere.
  const { writableStates, touchedStates } = useMemo(() => {
    const live = (l: License) => licenseHealth(l).level !== "expired";
    const states = new Set(licenses.map((l) => l.state).filter(Boolean));
    let writable = 0;
    for (const s of states) {
      const hasFirm = allFirm.some((l) => l.state === s && live(l));
      const hasProducer = allPersonal.some((l) => l.state === s && live(l));
      if (hasFirm && hasProducer) writable++;
    }
    return { writableStates: writable, touchedStates: states.size };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [licenses]);

  async function del(id: string) {
    await client.models.License.delete({ id });
    setLicenses((ls) => ls.filter((l) => l.id !== id));
  }

  if (loading) return <p className="muted small">Loading licenses…</p>;

  return (
    <>
      {error && <p className="error-text">{error}</p>}

      {isAdmin && (
        <LegacyBackfill
          licenses={licenses}
          profiles={profiles}
          onMigrated={(created) => setLicenses((ls) => [...ls, ...created])}
        />
      )}

      <div className="card lic-bar">
        <div className="lic-stats">
          <div className="lic-stat">
            <strong>{allFirm.length}</strong>
            <span className="muted small">firm</span>
          </div>
          <div className="lic-stat">
            <strong>{allPersonal.length}</strong>
            <span className="muted small">personal</span>
          </div>
          <div className="lic-stat">
            <strong>{writableStates}</strong>
            <span className="muted small">
              of {touchedStates} states writable
            </span>
          </div>
        </div>

        <div className="lic-controls">
          <div className="view-switch" role="group" aria-label="Licensing view">
            {VIEWS.map((v) => (
              <button
                key={v.key}
                aria-pressed={view === v.key}
                onClick={() => setView(v.key)}
              >
                {v.label}
              </button>
            ))}
          </div>

          {/* The filter belongs to the tables. On the map it would be a lie:
              narrowing the rows to "NH" would repaint the other fifty states
              red, and red there means "we can't write here" rather than "you
              filtered them out". */}
          {view !== "map" && (
            <>
              <input
                className="lic-search"
                type="search"
                placeholder="Filter by state, license #, NPN, person…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {attentionCount > 0 && (
                <button
                  className={`lic-chip${attentionOnly ? " on" : ""}`}
                  onClick={() => setAttentionOnly((v) => !v)}
                  title="Expired, inactive, or expiring within 60 days"
                >
                  ⚠ {attentionCount} need{attentionCount === 1 ? "s" : ""} attention
                </button>
              )}
              {filtering && (
                <button
                  className="link"
                  onClick={() => {
                    setQuery("");
                    setAttentionOnly(false);
                  }}
                >
                  Clear
                </button>
              )}
            </>
          )}
        </div>

        {view !== "map" && filtering && (
          <p className="muted small" style={{ margin: "8px 0 0" }}>
            Showing {counts.shown} of {counts.total} {counts.noun}.
          </p>
        )}
      </div>

      {view === "map" && (
        <Suspense fallback={<p className="muted small">Loading map…</p>}>
          {/* Unfiltered on purpose — see the note on the filter above. */}
          <LicenseMap
            firm={allFirm}
            personal={allPersonal}
            profiles={profiles}
            canEdit={isAdmin}
            onEdit={(l) => {
              setAdding(null);
              setEditing(l);
            }}
          />
        </Suspense>
      )}

      {view === "firm" && (
        <LicenseTable
          title="Firm licenses"
          blurb="The agency's own business-entity licenses, one per state you write in."
          rows={firm}
          profiles={profiles}
          canEdit={isAdmin}
          onAdd={() => {
            setEditing(null);
            setAdding("FIRM");
          }}
          onEdit={(l) => {
            setAdding(null);
            setEditing(l);
          }}
          onDelete={del}
          openDocsFor={openDocsFor}
          setOpenDocsFor={setOpenDocsFor}
        />
      )}

      {view === "people" && (
        <LicenseTable
          title="Personal licenses"
          blurb="Individual producer licenses, tied to a team member. Pick a name to see theirs."
          rows={personal}
          profiles={profiles}
          canEdit={isAdmin}
          showHolder
          groupByHolder
          // A filter has to open the groups it matched inside, or the results
          // are hidden behind the names that contain them.
          autoExpand={filtering}
          onAdd={() => {
            setEditing(null);
            setAdding("PRODUCER");
          }}
          onEdit={(l) => {
            setAdding(null);
            setEditing(l);
          }}
          onDelete={del}
          openDocsFor={openDocsFor}
          setOpenDocsFor={setOpenDocsFor}
        />
      )}

      {/* The coverage matrix is the map's own question in table form, so it
          belongs to the view that isn't already answering it. */}
      {view === "coverage" && (
        <StateCoverage firm={firm} personal={personal} profiles={profiles} />
      )}

      {/*
        In a modal, not appended to the page.

        This used to render after both tables and the coverage matrix, so
        clicking Edit on the first row scrolled nothing — the form opened
        thousands of pixels below, and from the map view it was off-screen
        entirely. `modal-form` is the variant the other editors already use:
        the `.preview-*` shell is sized to centre one object, which a form has
        to override to start at the top and grow.
      */}
      {(adding || editing) && (
        <Modal
          title={`${editing ? "Edit" : "Add"} ${
            (editing ? editing.holderType : adding) === "FIRM" ? "firm" : "personal"
          } license`}
          className="modal-form"
          closeLabel="Cancel"
          onClose={() => {
            setAdding(null);
            setEditing(null);
          }}
        >
          <LicenseForm
            // Remount per subject: without this the form keeps the previously
            // edited licence's values and saves them onto the next one.
            key={editing?.id ?? "new"}
            holderType={editing ? (editing.holderType as HolderType) : adding!}
            existing={editing}
            profiles={profiles}
            onCancel={() => {
              setAdding(null);
              setEditing(null);
            }}
            onSaved={(l) => {
              setLicenses((ls) => {
                const without = ls.filter((x) => x.id !== l.id);
                return [...without, l];
              });
              setAdding(null);
              setEditing(null);
            }}
          />
        </Modal>
      )}
    </>
  );
}
