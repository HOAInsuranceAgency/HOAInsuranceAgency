import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAsyncResource } from "../lib/useAsyncResource";
import {
  HIT_TYPE_LABEL,
  MIN_QUERY_LENGTH,
  searchRows,
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

interface Item {
  key: string;
  group: string;
  label: string;
  sub: string;
  target: string;
  /** The "See all results" footer row, styled apart. */
  isFooter?: boolean;
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

  const items = useMemo<Item[]>(() => {
    if (qt.length < MIN_QUERY_LENGTH) return [];
    const out: Item[] = [];
    for (const g of groups) {
      for (const h of g.hits) {
        out.push({
          key: `${h.type}-${h.id}`,
          group: groupLabel(g.type, g.more),
          label: h.label,
          sub: h.sub,
          target: h.target,
        });
      }
    }
    for (const d of docHits) {
      out.push({
        key: `doc-${d.id}`,
        group: "Documents",
        label: d.name,
        sub:
          d.entityType === "ACCOUNT"
            ? accountNames.get(d.entityId) ?? "Account"
            : d.entityType.charAt(0) + d.entityType.slice(1).toLowerCase(),
        target: docTarget(d),
      });
    }
    out.push({
      key: "footer",
      group: "",
      label: `See all results for “${qt}”`,
      sub: "",
      target: `/search?q=${encodeURIComponent(qt)}`,
      isFooter: true,
    });
    return out;
  }, [groups, docHits, qt, accountNames]);

  // A new answer set restarts selection at the top hit, so Enter always
  // means "the best match on screen".
  useEffect(() => setActive(0), [qt, items.length]);

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
    if (!open || items.length === 0) {
      if (e.key === "Enter" && qt.length >= MIN_QUERY_LENGTH) {
        go(`/search?q=${encodeURIComponent(qt)}`);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      const item = items[Math.min(active, items.length - 1)];
      if (item) go(item.target);
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
  let lastGroup: string | null = null;

  return (
    <div className="topbar">
      <div className="usearch" ref={boxRef}>
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded={showPop}
          aria-controls="usearch-listbox"
          aria-activedescendant={
            showPop && items[active] ? `usearch-opt-${active}` : undefined
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
            if (!index.loaded && !index.loading) void index.refetch();
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
                {items.map((item, i) => {
                  const header =
                    item.group && item.group !== lastGroup ? item.group : null;
                  lastGroup = item.group;
                  return (
                    <div key={item.key}>
                      {header && <div className="usearch-group">{header}</div>}
                      <div
                        id={`usearch-opt-${i}`}
                        role="option"
                        aria-selected={i === active}
                        className={`usearch-hit${i === active ? " on" : ""}${item.isFooter ? " usearch-all" : ""}`}
                        // mousedown, not click: click fires after the input's
                        // blur has already closed the dropdown.
                        onMouseDown={(e) => {
                          e.preventDefault();
                          go(item.target);
                        }}
                        onMouseEnter={() => setActive(i)}
                      >
                        <span className="hit-label">{item.label}</span>
                        {item.sub && <span className="sub">{item.sub}</span>}
                      </div>
                    </div>
                  );
                })}
                {docSearching && (
                  <div className="usearch-note">Searching documents…</div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function groupLabel(type: SearchHitType, more: number): string {
  return more > 0 ? `${HIT_TYPE_LABEL[type]} · +${more} more` : HIT_TYPE_LABEL[type];
}

/** Where a document hit lands: the entity's documents, when the entity has
 * a page — otherwise the full results page, which renders every entity
 * type honestly. */
function docTarget(d: DocumentHit): string {
  if (d.entityType === "ACCOUNT") return `/accounts/${d.entityId}?tab=documents`;
  if (d.entityType === "CARRIER") return `/carriers/${d.entityId}`;
  return `/search?q=${encodeURIComponent(d.name)}`;
}
