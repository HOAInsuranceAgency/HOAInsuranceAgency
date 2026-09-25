import { useMemo, useState } from "react";

type SortDir = "asc" | "desc";
type SortAccessor<T> = (item: T) => string | number | null | undefined;

/**
 * Column sorting for tables. Null/undefined values always sort last
 * (regardless of direction) — so "no renewal date" never beats a real one.
 */
export function useSort<T>(
  items: T[],
  accessors: Record<string, SortAccessor<T>>,
  defaultKey: string,
  defaultDir: SortDir = "asc",
  controlled?: { key: string; dir: SortDir }
) {
  const [localKey, setSortKey] = useState(defaultKey);
  const [localDir, setDir] = useState<SortDir>(defaultDir);
  const sortKey = controlled?.key ?? localKey;
  const dir = controlled?.dir ?? localDir;

  function toggle(key: string) {
    if (key === sortKey) {
      setDir(dir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setDir("asc");
    }
  }

  const sorted = useMemo(() => {
    const acc = accessors[sortKey];
    if (!acc) return items;
    const mult = dir === "asc" ? 1 : -1;
    return [...items].sort((a, b) => {
      const va = acc(a);
      const vb = acc(b);
      const aNull = va == null || va === "";
      const bNull = vb == null || vb === "";
      if (aNull && bNull) return 0;
      if (aNull) return 1; // nulls last, always
      if (bNull) return -1;
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * mult;
      return String(va).localeCompare(String(vb), undefined, { sensitivity: "base" }) * mult;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, sortKey, dir]);

  return { sorted, sortKey, dir, toggle };
}

export function SortTh({
  label,
  colKey,
  sortKey,
  dir,
  onToggle,
}: {
  label: string;
  colKey: string;
  sortKey: string;
  dir: SortDir;
  onToggle: (key: string) => void;
}) {
  const active = colKey === sortKey;
  return (
    <th className="sortable" aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className="sort-button" onClick={() => onToggle(colKey)}>{label}
      <span className="arrow">{active ? (dir === "asc" ? " ▲" : " ▼") : ""}</span>
      </button>
    </th>
  );
}

/** Visible when table headers are replaced by mobile record cards. */
export function MobileSort({ options, sortKey, dir, onToggle }: {
  options: readonly (readonly [key: string, label: string])[];
  sortKey: string;
  dir: SortDir;
  onToggle: (key: string) => void;
}) {
  if (!options.length) return null;
  return <div className="mobile-sort" role="group" aria-label="Sort records">
    <label className="field">Sort by<select value={sortKey} onChange={event => { if (event.target.value !== sortKey) onToggle(event.target.value); }}>
      {options.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
    </select></label>
    <label className="field">Sort order<select value={dir} onChange={event => { if (event.target.value !== dir) onToggle(sortKey); }}>
      <option value="asc">Ascending</option><option value="desc">Descending</option>
    </select></label>
  </div>;
}
