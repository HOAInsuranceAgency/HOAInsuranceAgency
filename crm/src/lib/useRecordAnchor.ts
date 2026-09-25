import { useEffect } from "react";

/** A directory link can target a record whose row arrives after navigation. */
export function useRecordAnchor(prefix: "quote" | "policy", loaded: boolean) {
  const hash = window.location.hash;
  useEffect(() => {
    if (!loaded || !hash.startsWith(`#${prefix}-`)) return;
    const frame = requestAnimationFrame(() => document.getElementById(hash.slice(1))?.scrollIntoView({ block: "center" }));
    return () => cancelAnimationFrame(frame);
  }, [prefix, loaded, hash]);
}
