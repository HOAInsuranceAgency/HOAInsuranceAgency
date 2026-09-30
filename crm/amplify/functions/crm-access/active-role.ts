import { AccessDenied } from "./policy";

export type RoleRequest = { headers?: Record<string, unknown> };
export type ActiveRole = "ADMIN" | "STAFF" | "PRODUCER";
const roles: ActiveRole[] = ["ADMIN", "STAFF", "PRODUCER"];

/** A view selection can narrow a signed-in user's privileges; only the
 * verified Cognito identity can establish which roles they may select. */
export function activeRole(identity: unknown, request?: RoleRequest): ActiveRole | undefined {
  const user = identity as { groups?: unknown; claims?: Record<string, unknown> } | null | undefined;
  const rawGroups = user?.groups ?? user?.claims?.["cognito:groups"];
  const groups: unknown[] = Array.isArray(rawGroups) ? rawGroups : [];
  const selected = Object.entries(request?.headers ?? {}).filter(([name]) => name.toLowerCase() === "x-crm-role");
  if (!selected.length) return roles.find(role => groups.includes(role));
  if (selected.length !== 1) throw new AccessDenied();
  const role = selected[0][1];
  if (typeof role !== "string" || !roles.includes(role as ActiveRole) || !groups.includes(role)) throw new AccessDenied();
  return role as ActiveRole;
}

export const isActiveAdmin = (identity: unknown, request?: RoleRequest) => activeRole(identity, request) === "ADMIN";
