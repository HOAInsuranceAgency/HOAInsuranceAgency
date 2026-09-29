import type { ChartSeries } from '../components/StackedBars';
import type { CommercialData } from './commercial';

export const UNASSIGNED = 'unassigned';
const PERSON_COLORS = ['#2469a5', '#168071', '#7859aa', '#bd6a20', '#b74765', '#52699d', '#62852a', '#99663d', '#008cba', '#ab4c93', '#4d783d', '#c14838'];
export function salespersonKey(accountId: string, entries: Readonly<Record<string, { salespersonId?: string | null }>>): string {
  return entries[accountId]?.salespersonId || UNASSIGNED;
}

/** Include former/ineligible owners when they still own records. IDs, never
 * names, are the grouping key, including when teammates share a name. */
export function salespersonSeries({ entries, team }: CommercialData): ChartSeries[] {
  const ids = new Set(team.filter(person => person.salesperson).map(person => person.userId));
  for (const entry of Object.values(entries)) if (entry.salespersonId) ids.add(entry.salespersonId);
  // Resolve collisions across the complete roster before drawing any chart.
  // Sorting IDs makes order/filter changes harmless and all tabs share colors.
  const colors = new Map<string, string>();
  const used = new Set<string>();
  for (const id of [...ids].sort()) {
    let hash = 0;
    for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) | 0;
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
  const series = [...ids].map(key => ({
    key,
    label: team.find(person => person.userId === key)?.name || `Unavailable teammate (${key.slice(-8)})`,
    color: colors.get(key),
  })).sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
  const names = new Map<string, number>();
  for (const item of series) names.set(item.label, (names.get(item.label) ?? 0) + 1);
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
