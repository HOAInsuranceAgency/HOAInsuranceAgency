import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Role } from "./auth";

type Scope = { userId: string; role: Role };
const ScopeContext = createContext<Scope | null>(null);
export function LeadDraftScope({ userId, role, children }: Scope & { children: ReactNode }) {
  return <ScopeContext.Provider key={JSON.stringify([userId, role])} value={{ userId, role }}>{children}</ScopeContext.Provider>;
}
const PREFIX = "hoa-crm:new-lead-draft:v1:";
const MAX_AGE = 24 * 60 * 60 * 1000;
// Deliberately exclude notes, financial values and file contents from recovery.
export const DRAFT_FIELDS = ["type", "propertyType", "name", "contactName", "contactType", "contactEmail", "contactPhone", "address", "city", "state", "zip", "unitCount", "currentAgent", "currentPolicyExpiration", "leadSource"] as const;
type Fields = Record<typeof DRAFT_FIELDS[number], string>;
type Draft = { version: 1; savedAt: number; requestId: string; fields: Fields; attachmentCount: number };
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
function read(key: string | null): Draft | null {
  if (!key) return null;
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw || raw.length > 40000) return null;
    const value = JSON.parse(raw) as Draft;
    if (value.version !== 1 || !Number.isFinite(value.savedAt) || value.savedAt > Date.now() || Date.now() - value.savedAt > MAX_AGE ||
      typeof value.requestId !== "string" || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value.requestId) || !value.fields ||
      !Number.isInteger(value.attachmentCount) || value.attachmentCount < 0 || value.attachmentCount > 1000 ||
      Object.keys(value.fields).some(field => !DRAFT_FIELDS.includes(field as typeof DRAFT_FIELDS[number])) ||
      DRAFT_FIELDS.some(field => typeof value.fields[field] !== "string" || value.fields[field].length > 2000)) {
      sessionStorage.removeItem(key); return null;
    }
    return value;
  } catch { return null; }
}

export function useNewLeadDraft(fields: Fields, requestId: string, attachmentCount: number, enabled: boolean) {
  const scope = useContext(ScopeContext);
  const key = scope ? keyFor(scope) : null;
  const [available, setAvailable] = useState(() => read(key));
  const [backedUp, setBackedUp] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const clear = () => {
    if (key) { try { sessionStorage.removeItem(key); } catch { /* Best effort. */ } }
    setAvailable(null); setBackedUp(false);
  };
  const serialized = JSON.stringify(Object.fromEntries(DRAFT_FIELDS.map(field => [field, fields[field]])));
  useEffect(() => {
    if (!key || available) return;
    if (!enabled) {
      try { sessionStorage.removeItem(key); } catch { /* Storage can be unavailable. */ }
      setBackedUp(false); return;
    }
    try {
      sessionStorage.setItem(key, JSON.stringify({ version: 1, savedAt: Date.now(), requestId, fields: JSON.parse(serialized), attachmentCount } satisfies Draft));
      setBackedUp(true); setUnavailable(false);
    } catch { setBackedUp(false); setUnavailable(true); }
  }, [key, available, enabled, requestId, serialized, attachmentCount]);
  return { available, backedUp, unavailable, scoped: !!key, clear, recovered: () => setAvailable(null) };
}
