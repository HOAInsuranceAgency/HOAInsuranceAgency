import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
export type CommissionDestination = { tab: string; intakeId?: string; statementId?: string; policyId?: string; departureId?: string; adjustmentId?: string; earningId?: string; cycleId?: string; earningKeys?: string[]; producerId?: string };
export const CommissionWorkflowContext = createContext<{ target: CommissionDestination; navigate: (target: CommissionDestination) => void; storageKey?: string; remember?: (target: Partial<CommissionDestination>) => void }>({ target: { tab: 'queue' }, navigate: () => {} });
export const useCommissionWorkflow = () => useContext(CommissionWorkflowContext);
/** Only navigation preferences belong in browser storage. Working values stay private on the server. */
export function useCommissionPreference<T>(name: string, initial: T) {
  const { storageKey } = useCommissionWorkflow();
  const [value, setValue] = useState(initial);
  const loaded = useRef('');
  const changedBeforeLoad = useRef(false);
  useEffect(() => {
    if (!storageKey) return;
    const key = storageKey + ':' + name;
    if (changedBeforeLoad.current && !loaded.current) {
      changedBeforeLoad.current = false;
      setValue(current => {
        try { localStorage.setItem(key, JSON.stringify(current)); } catch { /* Keep the current selection. */ }
        return current;
      });
    } else {
      try { const saved = localStorage.getItem(key); if (saved !== null) setValue(JSON.parse(saved)); } catch { /* Storage can be disabled. */ }
    }
    loaded.current = key;
  }, [storageKey, name]);
  const update = (next: T | ((old: T) => T)) => setValue(old => {
    const result = typeof next === 'function' ? (next as (old: T) => T)(old) : next;
    if (!Object.is(old, result) && !loaded.current) changedBeforeLoad.current = true;
    if (storageKey && loaded.current === storageKey + ':' + name) try { localStorage.setItem(loaded.current, JSON.stringify(result)); } catch { /* Keep editing in memory. */ }
    return result;
  });
  return [value, update] as const;
}
export function CommissionTarget({ kind, id, children }: { kind: keyof CommissionDestination; id: string; children: ReactNode }) {
  const { target } = useCommissionWorkflow();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (target[kind] !== id) return;
    const element = ref.current;
    element?.querySelectorAll('details').forEach(d => { d.open = true; });
    element?.scrollIntoView?.({ block: 'start' });
    element?.focus({ preventScroll: true });
  }, [target, kind, id]);
  return <div ref={ref} tabIndex={-1} className="commission-target">{children}</div>;
}
export function CommissionBadge({ children, tone = 'blue' }: { children: ReactNode; tone?: string }) {
  return <span className={'badge commission-badge ' + tone}>{children}</span>;
}
