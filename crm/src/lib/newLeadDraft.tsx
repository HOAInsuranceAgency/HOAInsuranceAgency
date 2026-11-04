import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Role } from "./auth";

type Scope = { userId: string; role: Role };
const ScopeContext = createContext<Scope | null>(null);
export function LeadDraftScope({ userId, role, children }: Scope & { children: ReactNode }) {
  return <ScopeContext.Provider key={JSON.stringify([userId, role])} value={{ userId, role }}>{children}</ScopeContext.Provider>;
}
const PREFIX = "hoa-crm:new-lead-draft:v1:";
const MAX_AGE = 24 * 60 * 60 * 1000;
export const MAX_DRAFT_CHARS = 40000, MAX_DRAFT_FIELD_CHARS = 2000, MAX_DRAFT_ATTACHMENTS = 1000;
// Deliberately exclude notes, financial values and file contents from recovery.
export const DRAFT_FIELDS = ["type", "propertyType", "name", "contactName", "contactType", "contactEmail", "contactPhone", "address", "city", "state", "zip", "unitCount", "currentAgent", "currentPolicyExpiration", "leadSource"] as const;
type Fields = Record<typeof DRAFT_FIELDS[number], string>;
type Draft = { version: 1; savedAt: number; requestId: string; fields: Fields; attachmentCount: number; attempted: boolean; existingId?: string };
const userPrefix = (userId: string) => `${PREFIX}${encodeURIComponent(userId)}:`;
const keyFor = (scope: Scope) => `${userPrefix(scope.userId)}${scope.role}`;
export function clearNewLeadDrafts(userId?: string) {
  try {
    const prefix = userId ? userPrefix(userId) : PREFIX;
    Object.keys(sessionStorage).filter(key => key.startsWith(prefix)).forEach(key => sessionStorage.removeItem(key));
  } catch { /* Storage can be unavailable. */ }
}
export function clearOtherUsersLeadDrafts(userId: string) {
  try {
    Object.keys(sessionStorage).filter(key => key.startsWith(PREFIX) && !key.startsWith(userPrefix(userId))).forEach(key => sessionStorage.removeItem(key));
  } catch { /* Storage can be unavailable. */ }
}
/** The same bounded, projected format is required for both writes and reads. */
function validDraft(candidate: unknown): Draft | null {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const value = candidate as Draft;
  if (value.version !== 1 || !Number.isFinite(value.savedAt) || value.savedAt > Date.now() || Date.now() - value.savedAt > MAX_AGE ||
    typeof value.requestId !== "string" || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value.requestId) ||
    !value.fields || typeof value.fields !== "object" || Array.isArray(value.fields) ||
    !Number.isInteger(value.attachmentCount) || value.attachmentCount < 0 || value.attachmentCount > MAX_DRAFT_ATTACHMENTS ||
    (value.attempted !== undefined && typeof value.attempted !== "boolean") ||
    (value.existingId !== undefined && (typeof value.existingId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.existingId))) ||
    Object.keys(value.fields).some(field => !DRAFT_FIELDS.includes(field as typeof DRAFT_FIELDS[number])) ||
    DRAFT_FIELDS.some(field => typeof value.fields[field] !== "string" || value.fields[field].length > MAX_DRAFT_FIELD_CHARS)) return null;
  const result: Draft = { version: 1, savedAt: value.savedAt, requestId: value.requestId,
    fields: Object.fromEntries(DRAFT_FIELDS.map(field => [field, value.fields[field]])) as Fields,
    attachmentCount: value.attachmentCount,
    // Older snapshots did not record whether a request reached the server.
    attempted: value.attempted ?? true, ...(value.existingId ? { existingId: value.existingId } : {}),
  };
  return JSON.stringify(result).length <= MAX_DRAFT_CHARS ? result : null;
}
function read(key: string | null): Draft | null {
  if (!key) return null;
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw || raw.length > MAX_DRAFT_CHARS) return null;
    return validDraft(JSON.parse(raw));
  } catch { return null; }
}

export function useNewLeadDraft(fields: Fields, requestId: string, attachmentCount: number, enabled: boolean) {
  const scope = useContext(ScopeContext);
  const key = scope ? keyFor(scope) : null;
  const [available, setAvailable] = useState(() => read(key));
  const [backedUp, setBackedUp] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const metadata = useRef<{ attempted: boolean; existingId?: string }>({ attempted: false });
  const clear = () => {
    if (key) { try { sessionStorage.removeItem(key); } catch { /* Best effort. */ } }
    setAvailable(null); setBackedUp(false);
    metadata.current = { attempted: false };
  };
  const serialized = JSON.stringify(Object.fromEntries(DRAFT_FIELDS.map(field => [field, fields[field]])));
  function persist() {
    if (!key) return;
    const next = validDraft({ version: 1, savedAt: Date.now(), requestId, fields: JSON.parse(serialized), attachmentCount, ...metadata.current });
    try {
      if (!next) throw new Error("Draft exceeds recovery limits");
      sessionStorage.setItem(key, JSON.stringify(next));
      setBackedUp(true); setUnavailable(false);
    } catch { setBackedUp(false); setUnavailable(true); }
  }
  function markAttempted() {
    metadata.current.attempted = true;
    // Mark a recoverable prior snapshot too when the newest fields are too
    // large. Preserve its valid fields instead of replacing it with bad data.
    if (key) {
      const previous = read(key);
      if (previous?.requestId === requestId) {
        try { sessionStorage.setItem(key, JSON.stringify({ ...previous, attempted: true })); } catch { /* persist reports unavailable below. */ }
      }
    }
    persist();
  }
  function rememberCreated(existingId: string) {
    metadata.current = { attempted: true, existingId };
    persist();
  }
  useEffect(() => {
    if (!key || available) return;
    if (!enabled) {
      try { sessionStorage.removeItem(key); } catch { /* Storage can be unavailable. */ }
      setBackedUp(false); return;
    }
    persist();
  }, [key, available, enabled, requestId, serialized, attachmentCount]);
  return { available, backedUp, unavailable, scoped: !!key, clear, markAttempted, rememberCreated,
    recovered: () => {
      if (available) metadata.current = { attempted: available.attempted, existingId: available.existingId };
      setAvailable(null);
    } };
}
