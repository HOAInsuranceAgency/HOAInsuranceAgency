/** Keep a confirmed newer row when a background index read briefly lags a
 * committed save. Iterate incoming membership so deletions/access filtering
 * never resurrect old rows. Dependency/role changes use a fresh resource. */
export function mergeLiveSnapshot<T>(previous: T, incoming: T): T {
  if (previous === incoming || !previous || !incoming || typeof previous !== 'object' || typeof incoming !== 'object') return incoming;
  if (Array.isArray(incoming)) {
    if (!Array.isArray(previous)) return incoming;
    const rows = new Map(previous.flatMap(value => value && typeof value === 'object' && typeof value.id === 'string' ? [[value.id, value] as const] : []));
    return incoming.map(value => value && typeof value === 'object' && typeof value.id === 'string'
      ? mergeLiveSnapshot(rows.get(value.id), value) : value) as T;
  }
  if (Array.isArray(previous) || Object.getPrototypeOf(incoming) !== Object.prototype
    || Object.getPrototypeOf(previous) !== Object.prototype) return incoming;
  const old = previous as Record<string, unknown>, next = incoming as Record<string, unknown>;
  if (typeof next.id === 'string' && next.id === old.id) {
    if (typeof old.version === 'number' && typeof next.version === 'number' && next.version < old.version) return previous;
    if (typeof old.updatedAt === 'string' && typeof next.updatedAt === 'string'
      && Date.parse(next.updatedAt) < Date.parse(old.updatedAt)) return previous;
  }
  return Object.fromEntries(Object.entries(next).map(([key, value]) => [key, mergeLiveSnapshot(old[key], value)])) as T;
}
