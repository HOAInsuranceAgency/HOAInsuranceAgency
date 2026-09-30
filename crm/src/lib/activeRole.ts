import { roleFromGroups, rolesFromGroups, type Role } from "./auth";

// A view preference, never an authorization grant. The server checks this
// header against the signed-in user's groups before applying the role's scope.
let requestRole: Role | null = null;
const storageKey = (userId: string) => `hoa-crm:active-role:${userId}`;

export async function activeRoleHeaders(): Promise<Record<string, string>> {
  return requestRole ? { "x-crm-role": requestRole } : {};
}

export function clearActiveRole() {
  requestRole = null;
}

export function setActiveRole(userId: string, role: Role, groups: string[]): Role {
  const roles = rolesFromGroups(groups);
  if (!roles.includes(role)) throw new Error("That role is not assigned to your account.");
  requestRole = role;
  try { sessionStorage.setItem(storageKey(userId), role); } catch { /* Storage can be disabled. */ }
  return role;
}

export function restoreActiveRole(userId: string, groups: string[]): Role {
  const roles = rolesFromGroups(groups);
  let saved: string | null = null;
  try { saved = sessionStorage.getItem(storageKey(userId)); } catch { /* Use the default role. */ }
  const role = roles.find(value => value === saved) ?? roleFromGroups(groups);
  // Ungrouped legacy users keep their existing non-admin access, without
  // asserting membership of the STAFF group in the request.
  if (!roles.length) { clearActiveRole(); return role; }
  return setActiveRole(userId, role, groups);
}
