/** Carrier inputs come from explicit answers, never inferred property values. */
export type EstimateInput = {
  address: string;
  submissionData: { buildingType: "condominium"; grossSQFeet: number; replacementValue: number; numUnits?: number };
};
export type EstimateRecord = {
  id: string; accountId: string; status: string; input?: string; result?: string;
  issue?: string; price?: number; estimationId?: string; createdAt: string; updatedAt: string; expiresAt: number;
};
export const PUBLIC_WINDOW_MS = 15 * 60_000;
export const PROCESSING_WINDOW_MS = 2 * 60_000;
const numeric = (v: unknown) => typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v.trim()) : NaN;
export function estimateInput(args: {
  type?: string | null; propertyKind?: string | null; grossSquareFeet?: string | null; replacementValue?: string | null;
  address?: string | null; city?: string | null; state?: string | null; zip?: string | null; unitCount?: string | null;
}): EstimateInput | null {
  if (args.type !== "ASSOCIATION" || args.propertyKind !== "condominium") return null;
  const grossSQFeet = numeric(args.grossSquareFeet), replacementValue = numeric(args.replacementValue);
  if (!Number.isFinite(grossSQFeet) || grossSQFeet < 500 || !Number.isFinite(replacementValue) || replacementValue < 150000 || replacementValue > 99999999) return null;
  if (!args.address?.trim() || args.address.length > 500 || !args.city?.trim() || args.city.length > 100 || !/^[A-Z]{2}$/.test(args.state ?? "")) return null;
  const numUnits = numeric(args.unitCount);
  return {
    address: [args.address.trim(), args.city.trim(), args.state, args.zip?.trim()].filter(Boolean).join(", "),
    submissionData: { buildingType: "condominium", grossSQFeet, replacementValue,
      ...(Number.isSafeInteger(numUnits) && numUnits > 0 ? { numUnits } : {}) },
  };
}
export function visibleStatus(record: Pick<EstimateRecord, "status" | "createdAt">, now = Date.now()): string {
  return ["PENDING", "RUNNING"].includes(record.status) && now - Date.parse(record.createdAt) > PROCESSING_WINDOW_MS ? "TIMED_OUT" : record.status;
}
/** The public receipt cannot disclose carrier identity, reasons, or account data. */
export function publicEstimate(record: EstimateRecord | undefined, now = Date.now()) {
  if (!record || record.expiresAt * 1000 <= now) return { status: "unavailable" };
  const status = visibleStatus(record, now);
  if (status === "READY" && Number.isFinite(record.price) && record.price! > 0) return { status: "ready", price: record.price, currency: "USD", staging: true };
  if (status === "PENDING" || status === "RUNNING") return { status: "pending" };
  return { status: "unavailable" };
}
