import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useBlocker } from "react-router-dom";
import Modal from "../components/Modal";

type Editor = { dirty: () => boolean; busy: () => boolean; discard: () => void };
const Context = createContext({
  register: (_key: symbol, _editor: Editor) => () => {},
  changed: () => {},
  requestLeave: (action: () => void) => action(),
  isLeaving: (): boolean => false,
});

/** One data-router blocker also covers tabs, browser Back and session actions. */
export function EditProtectionProvider({ children }: { children: ReactNode }) {
  const editors = useRef(new Map<symbol, Editor>());
  const [revision, setRevision] = useState(0);
  const [action, setAction] = useState<(() => void) | null>(null);
  const resolving = useRef(false);
  const changed = useCallback(() => setRevision(value => value + 1), []);
  const dirty = useCallback(() => [...editors.current.values()].some(editor => editor.dirty()), []);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty() &&
    `${currentLocation.pathname}${currentLocation.search}${currentLocation.hash}` !==
    `${nextLocation.pathname}${nextLocation.search}${nextLocation.hash}`);
  const pending = useRef(false);
  pending.current = blocker.state === "blocked" || !!action;
  const isLeaving = useCallback(() => pending.current, []);
  const register = useCallback((key: symbol, editor: Editor) => {
    editors.current.set(key, editor);
    return () => { editors.current.delete(key); };
  }, []);
  const requestLeave = useCallback((next: () => void) => {
    if (dirty()) setAction(() => next);
    else next();
  }, [dirty]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);
  useEffect(() => {
    if (blocker.state === "unblocked" && !action) resolving.current = false;
    // A save completing while navigation is held fulfils the original request.
    if (dirty() || resolving.current) return;
    if (blocker.state === "blocked" || action) resolving.current = true;
    if (blocker.state === "blocked") blocker.proceed();
    if (action) { setAction(null); action(); }
  }, [action, blocker, dirty, revision]);
  const keepEditing = () => {
    resolving.current = true;
    if (blocker.state === "blocked") blocker.reset();
    setAction(null);
  };
  const saving = [...editors.current.values()].some(editor => editor.dirty() && editor.busy());
  const discard = () => {
    if (saving || resolving.current) return;
    resolving.current = true;
    [...editors.current.values()].filter(editor => editor.dirty()).forEach(editor => editor.discard());
    const next = action;
    setAction(null);
    if (blocker.state === "blocked") blocker.proceed();
    else next?.();
  };
  const value = useMemo(() => ({ register, changed, requestLeave, isLeaving }), [register, changed, requestLeave, isLeaving]);
  return <Context.Provider value={value}>
    {children}
    {(blocker.state === "blocked" || action) && <Modal title={saving ? "Saving is still in progress" : "Leave with unsaved changes?"} onClose={keepEditing} closeLabel="Keep editing">
      <p>{saving ? "Wait for this save to finish before leaving this page." : "Your changes have not been saved. Stay here to finish, or discard them and continue."}</p>
      {!saving && <button type="button" className="secondary" onClick={discard}>Discard changes and continue</button>}
    </Modal>}
  </Context.Provider>;
}

export const useEditProtection = () => useContext(Context);

export function useUnsavedChanges(dirty: boolean, options: { busy?: boolean; onDiscard?: () => void } = {}) {
  const context = useContext(Context);
  const key = useRef(Symbol("editor"));
  const latest = useRef({ dirty, ...options });
  latest.current = { dirty, ...options };
  useEffect(() => context.register(key.current, {
    dirty: () => latest.current.dirty,
    busy: () => !!latest.current.busy,
    discard: () => { latest.current.dirty = false; latest.current.onDiscard?.(); },
  }), [context.register]);
  useEffect(context.changed, [dirty, options.busy, context.changed]);
  const markClean = useCallback(() => { latest.current.dirty = false; context.changed(); }, [context.changed]);
  return { markClean, isLeaving: context.isLeaving };
}
