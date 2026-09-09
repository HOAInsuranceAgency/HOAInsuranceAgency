import { normalizePhone } from "../../../../shared/leadWorkflow";
type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const str = (value: unknown) => typeof value === "string" || typeof value === "number" ? String(value) : "";
export function dialpadBusinessLine(p: Json) {
  const target = object(p.target), fallback = p.direction === "inbound" ? p.to_number : p.direction === "outbound" ? p.from_number : undefined;
  return normalizePhone(str(p.internal_number || target.phone_number || target.phone || object(p.entry_point_target).phone || (Array.isArray(fallback) ? fallback[0] : fallback)));
}
/** Unknown line scope is reviewable by provider ID without retaining private content. */
export function unidentifiedDialpadReceipt(p: Json) {
  return Object.fromEntries(["id", "call_id", "master_call_id", "entry_point_call_id", "operator_call_id", "direction", "state", "event_timestamp", "created_date", "date_started", "date_connected", "date_ended"].map(key => [key, typeof p[key] === "string" || typeof p[key] === "number" ? p[key] : undefined]));
}
