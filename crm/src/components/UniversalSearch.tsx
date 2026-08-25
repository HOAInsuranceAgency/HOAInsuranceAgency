import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAsyncResource } from "../lib/useAsyncResource";
import {
  HIT_TYPE_LABEL,
  MIN_QUERY_LENGTH,
  searchRows,
  sentence,
  splitMatch,
  type SearchHitType,
} from "../lib/universalSearch";
import {
  fetchDocumentHits,
  fetchSearchIndexRows,
  type DocumentHit,
} from "../lib/searchIndexData";

/** How long typing may pause before the document query fires. The a-tier
 * index answers every keystroke from memory; only the server-side document
 * search needs holding back. */
const DOC_DEBOUNCE_MS = 350;

interface HitItem {
  key: string;
  type: SearchHitType | "document";
  label: string;
  sub: string;
  target: string;
}

interface RenderGroup {
  name: string;
  /** Right-aligned header note: "top 5 of 12", or "searching…". */
  note: string | null;
  items: HitItem[];
}

/**
 * The top-of-page universal search: one box over the a-tier objects and the
 * document store, consolidating the old /documents page's search.
 *
 * Two lanes with different physics, one dropdown: accounts, contacts,
 * policies, invoices, certificates and carriers are answered per keystroke
 * from an in-memory index (six narrow scans, fetched lazily on first focus
 * and kept for the session), while documents — whose text lives server-side
 * and weighs megabytes — are a debounced `contains` query that fills its
 * section in when it lands. Enter with nothing chosen goes to /search, the
 * full results page, which keeps the old page's snippets, previews and
 * downloads.
 */
export default function UniversalSearch() {
  const navigate = useNavigate();
  const location = useLocation();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [docHits, setDocHits] = useState<DocumentHit[]>([]);
  const [docSearching, setDocSearching] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const docTicket = useRef(0);

  // The index is per-session and lazy: nothing is fetched until someone
  // first puts focus in the box. A failed build retries on the next focus.
  const index = useAsyncResource(fetchSearchIndexRows, [], {
    manual: true,
    initialData: [],
    errorMessage: "Couldn't build the search index",
  });

  // Landing on /search (a sent link, a bookmark) puts the page's query in
  // the box, so refining it is an edit rather than a retype. Keyed on the
  // navigation, not on q — typing afterwards must not be overwritten. The
  // trailing slash matters: Amplify's CDN serves a direct load as
  // "/search/?q=…", which is exactly the sent-link case this exists for.
  useEffect(() => {
    if (location.pathname.replace(/\/+$/, "") === "/search") {
      const urlQ = new URLSearchParams(location.search).get("q") ?? "";
      if (urlQ) setQ(urlQ);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

  const qt = q.trim();
  const groups = useMemo(() => searchRows(index.data, qt), [index.data, qt]);

  // The document lane: debounced, tickets dropping stale answers — a reply
  // to "harb" must not land on top of the results for "harbor".
  useEffect(() => {
    const ticket = ++docTicket.current;
    if (qt.length < MIN_QUERY_LENGTH) {
      setDocHits([]);
      setDocSearching(false);
      return;
    }
    setDocSearching(true);
    const timer = setTimeout(() => {
      fetchDocumentHits(qt)
        .then((hits) => {
          if (docTicket.current !== ticket) return;
          setDocHits(hits);
          setDocSearching(false);
        })
        .catch(() => {
          // The dropdown's document section going quiet is not worth an
          // error banner mid-typeahead; /search reports failures properly.
          if (docTicket.current !== ticket) return;
          setDocHits([]);
          setDocSearching(false);
        });
    }, DOC_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [qt]);

  const accountNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of index.data) if (r.type === "account") m.set(r.id, r.label);
    return m;
  }, [index.data]);

  // The render model and the keyboard model, built together so the flat
  // index the arrows walk is the same one the section markup renders.
  const renderGroups = useMemo<RenderGroup[]>(() => {
    if (qt.length < MIN_QUERY_LENGTH) return [];
    const out: RenderGroup[] = groups.map((g) => ({
      name: HIT_TYPE_LABEL[g.type],
      note: g.more > 0 ? `top ${g.hits.length} of ${g.hits.length + g.more}` : null,
      items: g.hits.map((h) => ({
        key: `${h.type}-${h.id}`,
        type: h.type,
        label: h.label,
        sub: h.sub,
        target: h.target,
      })),
    }));
    if (docHits.length > 0 || docSearching) {
      out.push({
        name: "Documents",
        note: docSearching ? "searching…" : null,
        items: docHits.map((d) => ({
          key: `doc-${d.id}`,
          type: "document",
          label: d.name,
          sub:
            d.entityType === "ACCOUNT"
              ? accountNames.get(d.entityId) ?? "Account"
              : sentence(d.entityType),
          target: docTarget(d),
        })),
      });
    }
    return out;
  }, [groups, docHits, docSearching, qt, accountNames]);

  const flat = useMemo(() => renderGroups.flatMap((g) => g.items), [renderGroups]);
  const footerTarget = `/search?q=${encodeURIComponent(qt)}`;
  // The arrows walk every hit plus the footer, which is always the last
  // stop — so Enter never has nowhere to go once the query is long enough.
  const selectable = qt.length >= MIN_QUERY_LENGTH ? flat.length + 1 : 0;

  // A new QUERY restarts selection at the top hit. Deliberately not keyed
  // on the answer set: the debounced document lane appends its hits below
  // the a-tier rows the user may already be arrowing through, and snapping
  // back to the top mid-navigation would make Enter open a row they never
  // chose. `activeIdx` clamps the edge where a shrink strands the old value.
  useEffect(() => setActive(0), [qt]);
  const activeIdx = Math.min(active, Math.max(0, selectable - 1));

  // The dropdown scrolls; the highlight must not walk off the visible part
  // of it. Keyed on the clamped index so arrows always chase a real row.
  useEffect(() => {
    // Method-level optional chain: jsdom renders these rows without a
    // scrollIntoView at all.
    document
      .getElementById(`usearch-opt-${activeIdx}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeIdx]);

  function go(target: string) {
    setOpen(false);
    inputRef.current?.blur();
    navigate(target);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (!open || selectable === 0) {
      if (e.key === "Enter" && qt.length >= MIN_QUERY_LENGTH) go(footerTarget);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, selectable - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      go(activeIdx < flat.length ? flat[activeIdx].target : footerTarget);
    }
  }

  // "/" (and the muscle-memory Cmd/Ctrl-K) put focus here from anywhere —
  // unless the keystroke belongs to a field being typed in or a dialog.
  useEffect(() => {
    function onGlobalKey(e: KeyboardEvent) {
      const isSlash = e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey;
      const isCmdK = e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey);
      if (!isSlash && !isCmdK) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      )
        return;
      if (document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      inputRef.current?.focus();
    }
    window.addEventListener("keydown", onGlobalKey);
    return () => window.removeEventListener("keydown", onGlobalKey);
  }, []);

  // Clicking anywhere outside the box closes the dropdown.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const showPop = open && qt.length > 0;
  let flatIndex = -1;

  return (
    <div className="topbar">
      <div
        className="usearch"
        ref={boxRef}
        // Tabbing away must take the dropdown with it: the options are
        // non-focusable divs, so focus leaving the box always means the
        // reader has moved on. Hit clicks preventDefault their mousedown,
        // so selection never routes through this path.
        onBlur={(e) => {
          if (!boxRef.current?.contains(e.relatedTarget as Node)) setOpen(false);
        }}
      >
        <span className="usearch-glass" aria-hidden>
          <IconGlass />
        </span>
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded={showPop}
          aria-controls="usearch-listbox"
          aria-activedescendant={
            showPop && selectable > 0 ? `usearch-opt-${activeIdx}` : undefined
          }
          aria-label="Search"
          placeholder="Search accounts, contacts, policies, invoices, documents…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            setOpen(true);
            // The retry half of "a failed build retries on the next focus":
            // `loaded` settles true on failure too, so the error is what
            // re-arms the gate.
            if (!index.loading && (!index.loaded || index.error)) {
              void index.refetch();
            }
          }}
          onKeyDown={onKeyDown}
        />
        <span className="kbd" aria-hidden>/</span>

        {showPop && (
          <div className="usearch-pop" id="usearch-listbox" role="listbox">
            {qt.length < MIN_QUERY_LENGTH ? (
              <div className="usearch-note">Keep typing — two characters minimum.</div>
            ) : (
              <>
                {index.loading && (
                  <div className="usearch-note">Building the search index…</div>
                )}
                {index.error && (
                  <div className="usearch-note error-text">{index.error}</div>
                )}
                {index.loaded &&
                  !index.error &&
                  groups.length === 0 &&
                  docHits.length === 0 &&
                  !docSearching && (
                    <div className="usearch-note">
                      No quick matches — Enter searches document text in full.
                    </div>
                  )}
                {renderGroups.map((g) => (
                  <div className="usearch-section" key={g.name}>
                    <div className="usearch-group">
                      <span>{g.name}</span>
                      {g.note && <span className="note">{g.note}</span>}
                    </div>
                    {g.items.map((item) => {
                      flatIndex += 1;
                      const i = flatIndex;
                      return (
                        <div
                          key={item.key}
                          id={`usearch-opt-${i}`}
                          role="option"
                          aria-selected={i === activeIdx}
                          className={`usearch-hit${i === activeIdx ? " on" : ""}`}
                          // mousedown, not click: click fires after the
                          // input's blur has already closed the dropdown.
                          // Left button only — a right-click wants the
                          // context menu, not a navigation.
                          onMouseDown={(e) => {
                            if (e.button !== 0) return;
                            e.preventDefault();
                            go(item.target);
                          }}
                          onMouseEnter={() => setActive(i)}
                        >
                          <span className="ico">{TYPE_ICONS[item.type]}</span>
                          <span className="hit-body">
                            <span className="hit-label">
                              <Marked text={item.label} query={qt} />
                            </span>
                            {item.sub && (
                              <span className="sub">
                                <Marked text={item.sub} query={qt} />
                              </span>
                            )}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ))}
                <div
                  id={`usearch-opt-${flat.length}`}
                  role="option"
                  aria-selected={activeIdx === flat.length}
                  className={`usearch-foot${activeIdx === flat.length ? " on" : ""}`}
                  onMouseDown={(e) => {
                    if (e.button !== 0) return;
                    e.preventDefault();
                    go(footerTarget);
                  }}
                  onMouseEnter={() => setActive(flat.length)}
                >
                  <span className="foot-label">See all results for “{qt}”</span>
                  <span className="keys">
                    <kbd>↑</kbd>
                    <kbd>↓</kbd> move · <kbd>↵</kbd> open · <kbd>esc</kbd> close
                  </span>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** The query's occurrence in a display string, emphasized. Falls back to
 * the plain text when the visible string doesn't contain the query (the
 * match was on a hidden field, e.g. a legal name). */
function Marked({ text, query }: { text: string; query: string }) {
  const split = splitMatch(text, query);
  if (!split) return <>{text}</>;
  return (
    <>
      {split.before}
      <mark>{split.match}</mark>
      {split.after}
    </>
  );
}

/** Where a document hit lands: the entity's documents, when the entity has
 * a page — otherwise the full results page, which renders every entity
 * type honestly. */
function docTarget(d: DocumentHit): string {
  if (d.entityType === "ACCOUNT") return `/accounts/${d.entityId}?tab=documents`;
  if (d.entityType === "CARRIER") return `/carriers/${d.entityId}`;
  return `/search?q=${encodeURIComponent(d.name)}`;
}

// ── Hit icons: the sidebar's stroke style at 16px, one per type, so a
// mixed result list scans by shape before it is read. ───────────────────

const iconProps = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function IconGlass() {
  return (
    <svg {...iconProps}>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.5-4.5" />
    </svg>
  );
}

const TYPE_ICONS: Record<HitItem["type"], ReactNode> = {
  account: (
    <svg {...iconProps}>
      <path d="M4 21V5a1 1 0 011-1h9a1 1 0 011 1v16" />
      <path d="M15 9h4a1 1 0 011 1v11" />
      <path d="M2 21h20" />
      <path d="M7.5 8h2M7.5 12h2M7.5 16h2" />
    </svg>
  ),
  contact: (
    <svg {...iconProps}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c0-3.5 3-5.5 7-5.5s7 2 7 5.5" />
    </svg>
  ),
  policy: (
    <svg {...iconProps}>
      <path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  ),
  invoice: (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.5v9M14.2 9c-.5-.7-1.3-1.1-2.2-1.1-1.3 0-2.3.8-2.3 1.8s.9 1.5 2.3 1.7c1.4.2 2.3.7 2.3 1.7s-1 1.8-2.3 1.8c-.9 0-1.7-.4-2.2-1" />
    </svg>
  ),
  certificate: (
    <svg {...iconProps}>
      <circle cx="12" cy="9" r="5" />
      <path d="M9 13.5L8 21l4-2 4 2-1-7.5" />
    </svg>
  ),
  carrier: (
    <svg {...iconProps}>
      <path d="M3 21V10l9-6 9 6v11" />
      <path d="M2 21h20" />
      <path d="M9 21v-6h6v6" />
    </svg>
  ),
  document: (
    <svg {...iconProps}>
      <path d="M14 2H6a1 1 0 00-1 1v18a1 1 0 001 1h12a1 1 0 001-1V7l-5-5z" />
      <path d="M14 2v5h5M9 13h6M9 17h6" />
    </svg>
  ),
};
