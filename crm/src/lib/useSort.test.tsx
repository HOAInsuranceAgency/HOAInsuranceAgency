import { act, render, renderHook, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SortTh, useSort } from "./useSort";

const ITEMS = [
  { name: "Bravo", score: 2 },
  { name: "Charlie", score: 10 },
  { name: "Alpha", score: 0 },
];

function SortableTable({ onToggle, onSubmit }: {
  onToggle: (key: string) => void;
  onSubmit?: () => void;
}) {
  const { sorted, sortKey, dir, toggle } = useSort(ITEMS, {
    name: item => item.name,
    score: item => item.score,
  }, "name");
  function sort(key: string) {
    onToggle(key);
    toggle(key);
  }
  return <form onSubmit={event => { event.preventDefault(); onSubmit?.(); }}>
    <table aria-label="Sortable records">
      <thead><tr>
        <SortTh label="Name" colKey="name" sortKey={sortKey} dir={dir} onToggle={sort} />
        <SortTh label="Score" colKey="score" sortKey={sortKey} dir={dir} onToggle={sort} />
      </tr></thead>
      <tbody>{sorted.map(item => <tr key={item.name}><td>{item.name}</td><td>{item.score}</td></tr>)}</tbody>
    </table>
  </form>;
}

function rowNames() {
  return within(screen.getByRole("table", { name: "Sortable records" }))
    .getAllByRole("row").slice(1).map(row => within(row).getAllByRole("cell")[0].textContent);
}

describe("shared table sorting", () => {
  it("sorts with Enter and Space, announces direction, and does not submit an enclosing form", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const onSubmit = vi.fn();
    render(<SortableTable onToggle={onToggle} onSubmit={onSubmit} />);
    const name = screen.getByRole("button", { name: "Name" });
    const header = screen.getByRole("columnheader", { name: "Name" });
    expect(header).toHaveAttribute("aria-sort", "ascending");
    expect(screen.getByRole("columnheader", { name: "Score" })).toHaveAttribute("aria-sort", "none");
    expect(rowNames()).toEqual(["Alpha", "Bravo", "Charlie"]);
    name.focus();
    await user.keyboard("{Enter}");
    expect(onToggle).toHaveBeenCalledExactlyOnceWith("name");
    expect(header).toHaveAttribute("aria-sort", "descending");
    expect(rowNames()).toEqual(["Charlie", "Bravo", "Alpha"]);
    await user.keyboard(" ");
    expect(onToggle).toHaveBeenCalledTimes(2);
    expect(header).toHaveAttribute("aria-sort", "ascending");
    expect(rowNames()).toEqual(["Alpha", "Bravo", "Charlie"]);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps null, undefined and empty values after numeric values in either direction", () => {
    const items: { name: string; score?: number | string | null }[] = [
      { name: "High", score: 10 },
      { name: "Null", score: null },
      { name: "Zero", score: 0 },
      { name: "Undefined" },
      { name: "Empty", score: "" },
    ];
    const { result } = renderHook(() => useSort(items, { score: item => item.score }, "score"));
    expect(result.current.sorted.map(item => item.name)).toEqual(["Zero", "High", "Null", "Undefined", "Empty"]);
    act(() => result.current.toggle("score"));
    expect(result.current.sorted.map(item => item.name)).toEqual(["High", "Zero", "Null", "Undefined", "Empty"]);
    expect(items.map(item => item.name)).toEqual(["High", "Null", "Zero", "Undefined", "Empty"]);
  });

  it("toggles once when clicking the whole header or its button", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<SortableTable onToggle={onToggle} />);
    await user.click(screen.getByRole("columnheader", { name: "Name" }));
    expect(onToggle).toHaveBeenCalledExactlyOnceWith("name");
    expect(screen.getByRole("columnheader", { name: "Name" })).toHaveAttribute("aria-sort", "descending");
    await user.click(screen.getByRole("button", { name: "Score" }));
    expect(onToggle).toHaveBeenCalledTimes(2);
    expect(onToggle).toHaveBeenLastCalledWith("score");
    expect(screen.getByRole("columnheader", { name: "Name" })).toHaveAttribute("aria-sort", "none");
    expect(screen.getByRole("columnheader", { name: "Score" })).toHaveAttribute("aria-sort", "ascending");
    expect(rowNames()).toEqual(["Alpha", "Bravo", "Charlie"]);
  });
});
