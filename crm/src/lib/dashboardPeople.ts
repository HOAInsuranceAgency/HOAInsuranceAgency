import type { ChartSeries } from '../components/StackedBars';
import type { CommercialData } from './commercial';

export const UNASSIGNED = 'unassigned';
const PERSON_COLORS = ['#2469a5', '#168071', '#7859aa', '#bd6a20', '#b74765', '#52699d', '#62852a', '#99663d', '#008cba', '#ab4c93', '#4d783d', '#c14838'];
function personHash(id: string): number {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return hash >>> 0;
}
/** Missing roster members cannot reserve or move another person's palette
 * slot: their color depends on their own ID, not this report's membership. */
function unavailablePersonColor(id: string): string {
  // Mix nearby IDs across the hue space instead of giving "a" and "b"
  // almost indistinguishable adjacent colors.
  let hash = personHash(id);
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
  hash = (hash ^ (hash >>> 16)) >>> 0;
  return `hsl(${(hash % 36000) / 100} ${55 + ((hash >>> 16) % 16)}% ${35 + ((hash >>> 24) % 13)}%)`;
}
export function salespersonKey(accountId: string, entries: Readonly<Record<string, { salespersonId?: string | null }>>): string {
  return entries[accountId]?.salespersonId || UNASSIGNED;
}

/** Include former/ineligible owners when they still own records. IDs, never
 * names, are the grouping key, including when teammates share a name. */
export function salespersonSeries({ entries, team }: CommercialData): ChartSeries[] {
  const roster = new Map(team.map(person => [person.userId, person]));
  const ids = new Set(team.filter(person => person.salesperson).map(person => person.userId));
  for (const entry of Object.values(entries)) if (entry.salespersonId) ids.add(entry.salespersonId);
  // Resolve collisions across the complete roster before drawing any chart.
  // Ineligible/former owners reserve their slots even when this report has no
  // records for them. Scoped data therefore never changes an active owner's color.
  const colors = new Map<string, string>();
  const used = new Set<string>();
  for (const id of [...roster.keys()].sort()) {
    const hash = personHash(id);
    let offset = 0;
    let color: string;
    do {
      const index = ((hash >>> 0) + offset) % PERSON_COLORS.length;
      color = offset < PERSON_COLORS.length ? PERSON_COLORS[index] : `hsl(${(colors.size * 137.508) % 360} 58% 42%)`;
      offset++;
    } while (used.has(color));
    used.add(color);
    colors.set(id, color);
  }
  const labelFor = (key: string) => roster.get(key)?.name || `Unavailable teammate (${key.slice(-8)})`;
  const names = new Map<string, number>();
  for (const key of new Set([...roster.keys(), ...ids])) {
    const label = labelFor(key);
    names.set(label, (names.get(label) ?? 0) + 1);
  }
  const series = [...ids].map(key => ({
    key,
    label: labelFor(key),
    color: colors.get(key) ?? unavailablePersonColor(key),
  })).sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
  return [
    ...series.map(item => names.get(item.label)! > 1 ? { ...item, label: `${item.label} (${item.key.slice(-8)})` } : item),
    { key: UNASSIGNED, label: 'Unassigned', color: '#64748b' },
  ];
}

/** Rolling 30 days through this snapshot; invalid, undated and future events
 * must not inflate recent activity. */
export function isInLast30Days(value: string | null | undefined, now: Date): boolean {
  if (!value) return false;
  const at = Date.parse(value), end = now.getTime();
  return Number.isFinite(at) && at >= end - 30 * 86400000 && at <= end;
}
