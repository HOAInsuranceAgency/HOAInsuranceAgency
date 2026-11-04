import { useEffect, useRef } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import {
  accountViewFromParams, accountViewKey, accountViewParams, hasAccountViewParams,
  normalizeAccountView, readAccountView, saveAccountView,
  type AccountListStage, type AccountListView,
} from './accountListView';

export function useAccountListView(stage: AccountListStage, admin: boolean, scope?: string) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const key = accountViewKey(scope, stage);
  const markedScope = location.state?.accountListViewScope;
  // A copied URL is explicit and does not inherit the recipient's preferences.
  // A role switch in this same history entry instead restores that role's view.
  const changedScope = key && typeof markedScope === 'string' && markedScope !== key;
  const view = hasAccountViewParams(params) && !changedScope
    ? accountViewFromParams(params, stage, admin) : readAccountView(key, stage, admin);
  const canonical = accountViewParams(params, view, stage).toString();
  const raw = params.toString();
  useEffect(() => {
    saveAccountView(key, view);
    if (raw !== canonical || key && markedScope !== key) {
      setParams(canonical, { replace: true, state: { ...location.state, ...(key ? { accountListViewScope: key } : {}) } });
    }
  }, [canonical, raw, key, markedScope, location.state, setParams]);

  function update(patch: Partial<AccountListView>) {
    const next = normalizeAccountView({ ...view, ...patch }, stage, admin);
    saveAccountView(key, next);
    setParams(accountViewParams(params, next, stage), {
      replace: true, state: { ...location.state, ...(key ? { accountListViewScope: key } : {}) },
    });
  }
  return { ...view, update, reset: () => update(normalizeAccountView({}, stage, admin)), storageKey: key };
}

/** Restore a list's document position after its rows have actually loaded.
 * Only a numeric offset and safe view signature are kept, per role and tab. */
export function useAccountListPosition(key: string | null, view: AccountListView, loaded: boolean) {
  const signature = JSON.stringify(view);
  const position = useRef({ key, signature, y: window.scrollY, restored: false });
  if (position.current.key !== key) position.current = { key, signature, y: window.scrollY, restored: false };
  const current = position.current;
  current.signature = signature;
  useEffect(() => {
    if (!key) return;
    // Capture this key's object. Cleanup must never save a newer role/stage's
    // signature under the previous key if a caller reuses the mounted hook.
    const track = () => { current.y = window.scrollY; current.restored = true; };
    const save = () => {
      if (!current.restored) return;
      try { window.sessionStorage.setItem(`${key}:position`, JSON.stringify({ signature: current.signature, y: current.y })); } catch { /* Optional convenience. */ }
    };
    window.addEventListener('scroll', track, { passive: true });
    window.addEventListener('pagehide', save);
    return () => { save(); window.removeEventListener('scroll', track); window.removeEventListener('pagehide', save); };
  }, [key, current]);
  useEffect(() => {
    if (!loaded || !key || current.restored) return;
    try {
      const saved = JSON.parse(window.sessionStorage.getItem(`${key}:position`) ?? 'null');
      if (saved?.signature !== signature || !Number.isFinite(saved.y) || saved.y <= 0 || saved.y > 10_000_000) { current.restored = true; return; }
      const frame = requestAnimationFrame(() => {
        if (current.restored) return; // Keep a scroll made while rows were loading.
        current.restored = true; current.y = saved.y;
        window.scrollTo({ top: saved.y, behavior: 'instant' });
      });
      return () => cancelAnimationFrame(frame);
    } catch { current.restored = true; /* Ignore stale or disabled storage. */ }
  }, [key, current, loaded, signature]);
}
