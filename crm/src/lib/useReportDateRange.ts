import { useEffect, useMemo, useState } from 'react';
import type { DateRange } from './dateRange';

/** Hide old results immediately; combine nearby edits before starting a read. */
export function useReportDateRange(value: DateRange, valid: boolean): DateRange | null {
  const { from, to } = value;
  // Each distinct edit gets a new request identity, even a return to an old
  // range after its snapshot was hidden. Same-value clicks keep that identity.
  const requested = useMemo(() => ({ range: { from, to }, valid }), [from, to, valid]);
  const [applied, setApplied] = useState(requested);
  useEffect(() => {
    if (!requested.valid || requested === applied) return;
    const timer = setTimeout(() => setApplied(requested), 250);
    return () => clearTimeout(timer);
  }, [requested, applied]);
  return requested.valid && requested === applied ? applied.range : null;
}
