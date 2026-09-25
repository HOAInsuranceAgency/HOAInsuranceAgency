import { useState } from "react";

/** Bound the rendered work without hiding the full result count. */
export function useListPage<T>(items: T[], scope: string, size = 25) {
  const [state, setState] = useState({ scope, page: 1 });
  const page = state.scope === scope ? Math.min(state.page, Math.max(1, Math.ceil(items.length / size))) : 1;
  return { page, rows: items.slice((page - 1) * size, page * size), setPage: (next: number) => setState({ scope, page: next }), size };
}
