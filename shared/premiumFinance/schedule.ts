export interface ScheduleRow {
  n: number;
  dueDate: string;
  payment: number;
  interest: number;
  principal: number;
  balance: number;
}

/** Historical schedules may arrive as arrays or with one or two layers of AWSJSON encoding. */
export function parseScheduleJson(raw: unknown): ScheduleRow[] {
  let v: unknown = raw;
  try {
    if (typeof v === "string") v = JSON.parse(v);
    if (typeof v === "string") v = JSON.parse(v);
  } catch {
    return [];
  }
  return Array.isArray(v) ? (v as ScheduleRow[]) : [];
}
