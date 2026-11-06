import { Button } from "../components/ui/Button";
import { useMemo, useState } from "react";

export type SortDir = "asc" | "desc";
type SortAccessor<T> = (item: T) => string | number | null | undefined;
export type ControlledSort = { sortKey: string; dir: SortDir; onChange: (sortKey: string, dir: SortDir) => void };

/**
 * Column sorting for tables. Null/undefined values always sort last
 * (regardless of direction) — so "no renewal date" never beats a real one.
 */
export function useSort<T>(
  items: T[],
  accessors: Record<string, SortAccessor<T>>,
  defaultKey: string,
  defaultDir: SortDir = "asc",
  controlled?: ControlledSort,
) {
  const [internalKey, setSortKey] = useState(defaultKey);
  const [internalDir, setDir] = useState<SortDir>(defaultDir);
  const sortKey = controlled?.sortKey ?? internalKey;
  const dir = controlled?.dir ?? internalDir;

  function toggle(key: string) {
    const nextDir = key === sortKey && dir === "asc" ? "desc" : "asc";
    if (controlled) controlled.onChange(key, nextDir);
    else if (key === sortKey) setDir(current => current === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setDir('asc'); }
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
    <th className="sortable" aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"} onClick={() => onToggle(colKey)}>
      <Button variant="plain" type="button" className="sort-label">
        {label}
        <span className="arrow" aria-hidden="true">{active ? (dir === "asc" ? " ▲" : " ▼") : ""}</span>
      </Button>
    </th>
  );
}
