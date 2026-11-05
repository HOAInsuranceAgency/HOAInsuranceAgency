import { Button } from "../components/ui/Button";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useBlocker } from "react-router-dom";
import Modal from "../components/Modal";

type Attention = { message: string; review: () => void; continueLabel?: string };
type Editor = { dirty: () => boolean; busy: () => boolean; discard: () => void; attention: () => Attention | undefined };
type PendingAction = { generation: number; run: () => void };
const Context = createContext({
  register: (_key: symbol, _editor: Editor) => () => {},
  changed: () => {},
  requestLeave: (action: () => void) => action(),
  isLeaving: (): boolean => false,
  cancelPending: () => {},
});

/** One data-router blocker also covers tabs, browser Back and session actions. */
export function EditProtectionProvider({ children }: { children: ReactNode }) {
  const editors = useRef(new Map<symbol, Editor>());
  const [revision, setRevision] = useState(0);
  const [action, setAction] = useState<PendingAction | null>(null);
  const generation = useRef(0);
  const resolving = useRef(false);
  const changed = useCallback(() => setRevision(value => value + 1), []);
  const dirty = useCallback(() => [...editors.current.values()].some(editor => editor.dirty()), []);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty() &&
    `${currentLocation.pathname}${currentLocation.search}${currentLocation.hash}` !==
    `${nextLocation.pathname}${nextLocation.search}${nextLocation.hash}`);
  const latestBlocker = useRef(blocker);
  latestBlocker.current = blocker;
  const pending = useRef(false);
  pending.current = blocker.state === "blocked" || !!action;
  const isLeaving = useCallback(() => pending.current, []);
  const register = useCallback((key: symbol, editor: Editor) => {
    editors.current.set(key, editor);
    return () => { editors.current.delete(key); };
  }, []);
  const requestLeave = useCallback((next: () => void) => {
    if (dirty()) setAction({ generation: generation.current, run: next });
    else next();
  }, [dirty]);
  const cancelPending = useCallback(() => {
    generation.current++;
    pending.current = false;
    resolving.current = true;
    setAction(null);
    const current = latestBlocker.current;
    if (current.state === "blocked") current.reset();
  }, []);
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
    if (action) { setAction(null); if (action.generation === generation.current) action.run(); }
  }, [action, blocker, dirty, revision]);
  const keepEditing = cancelPending;
  const saving = [...editors.current.values()].some(editor => editor.dirty() && editor.busy());
  const attention = [...editors.current.values()].filter(editor => editor.dirty()).map(editor => editor.attention()).find(Boolean);
  const discard = () => {
    if (saving || resolving.current) return;
    resolving.current = true;
    [...editors.current.values()].filter(editor => editor.dirty()).forEach(editor => editor.discard());
    const next = action;
    setAction(null);
    if (blocker.state === "blocked") blocker.proceed();
    else if (next?.generation === generation.current) next.run();
  };
  const value = useMemo(() => ({ register, changed, requestLeave, isLeaving, cancelPending }), [register, changed, requestLeave, isLeaving, cancelPending]);
  return <Context.Provider value={value}>
    {children}
    {(blocker.state === "blocked" || action) && <Modal title={saving ? "Saving is still in progress" : attention ? "Lead created — review missing details" : "Leave with unsaved changes?"} onClose={keepEditing} closeLabel={attention && !saving ? "Stay here" : "Keep editing"}>
      <p>{saving ? "Wait for this save to finish before leaving this page." : attention?.message ?? "Your changes have not been saved. Stay here to finish, or discard them and continue."}</p>
      {!saving && <div className="form-actions">
        {attention && <Button variant="primary" type="button"  onClick={() => { cancelPending(); attention.review(); }}>Review the lead</Button>}
        <Button variant="secondary" type="button"  onClick={discard}>{attention?.continueLabel ?? (attention ? "Continue without fixing" : "Discard changes and continue")}</Button>
      </div>}
    </Modal>}
  </Context.Provider>;
}

export const useEditProtection = () => useContext(Context);

export function useUnsavedChanges(dirty: boolean, options: { busy?: boolean; onDiscard?: () => void; notice?: string; onReview?: () => void; continueLabel?: string } = {}) {
  const context = useContext(Context);
  const key = useRef(Symbol("editor"));
  const latest = useRef({ dirty, ...options });
  latest.current = { dirty, ...options };
  useEffect(() => context.register(key.current, {
    dirty: () => latest.current.dirty,
    busy: () => !!latest.current.busy,
    discard: () => { latest.current.dirty = false; latest.current.onDiscard?.(); },
    attention: () => latest.current.notice && latest.current.onReview ? { message: latest.current.notice, review: latest.current.onReview, continueLabel: latest.current.continueLabel } : undefined,
  }), [context.register]);
  useEffect(context.changed, [dirty, options.busy, options.notice, context.changed]);
  const markClean = useCallback(() => { latest.current.dirty = false; context.changed(); }, [context.changed]);
  return { markClean, isLeaving: context.isLeaving };
}
