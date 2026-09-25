import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useBlocker } from "react-router-dom";

type DirtyForms = { setDirty: (id: string, dirty: boolean) => void; confirmDiscard: () => boolean };
const Context = createContext<DirtyForms>({ setDirty: () => {}, confirmDiscard: () => true });
export const useDirtyForms = () => useContext(Context);

export function DirtyFormsProvider({ children }: { children: ReactNode }) {
  const forms = useRef(new Set<string>());
  const [dirty, setHasDirty] = useState(false);
  const setDirty = useCallback((id: string, value: boolean) => {
    if (value) forms.current.add(id); else forms.current.delete(id);
    setHasDirty(forms.current.size > 0);
  }, []);
  const confirmDiscard = useCallback(() => !forms.current.size || window.confirm("You have unsaved changes. Leave without saving?"), []);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => forms.current.size > 0 && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search));
  useEffect(() => {
    if (blocker.state === "blocked") { if (confirmDiscard()) blocker.proceed(); else blocker.reset(); }
  }, [blocker, confirmDiscard]);
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);
  const value = useMemo(() => ({ setDirty, confirmDiscard }), [setDirty, confirmDiscard]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useDirtyForm(dirty: boolean) {
  const id = useId();
  const { setDirty } = useDirtyForms();
  useEffect(() => { setDirty(id, dirty); return () => setDirty(id, false); }, [dirty, id, setDirty]);
  return useCallback(() => setDirty(id, false), [id, setDirty]);
}
