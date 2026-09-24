/** Shared validation and display helpers; no secrets or browser data client. */
export type SubmissionDetails = {
  address: string; effectiveDate: string; nameInsured: string;
  buildingType?: string; grossSQFeet?: string | number; replacementValue?: string | number;
  numUnits?: string | number; yearBuilt?: string | number; numStories?: string | number;
};
export type PartialInput = { address: string; estimationId?: string; submissionData: Record<string, string | number> };
export type SourceEstimate = { id: string; accountId: string; estimationId?: string | null; input?: string | null; result?: string | null; status: string };
export type SubmissionRecord = {
  id: string; accountId: string; effectiveDate: string; status: string; attempt: number;
  input: string; sourceEstimateId?: string; estimationId?: string; requestedBy: string;
  createdAt: string; updatedAt: string; requestedAt: string; history?: string;
  submissionId?: string; readableSubmissionId?: string; submissionStatus?: string;
  portalUrl?: string; result?: string; issue?: string; resolvedBy?: string; resolutionNote?: string;
};
export function object(value: unknown): Record<string, unknown> {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}
export function eligibleEstimate(estimate: SourceEstimate): boolean {
  return !!estimate.estimationId && ["READY", "UNAVAILABLE"].includes(estimate.status) && object(estimate.result).isOkToSubmit === true;
}
export function businessDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  return ["year", "month", "day"].map(type => parts.find(p => p.type === type)!.value).join("-");
}
export function lastEffectiveDate(now = new Date()): string {
  return new Date(Date.parse(businessDate(now)) + 90 * 86400000).toISOString().slice(0, 10);
}
function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new Error(`${label} is required (maximum ${max} characters).`);
  return value.trim();
}
export function partialInput(details: unknown, estimate?: SourceEstimate, now = new Date()): PartialInput {
  const d = object(details);
  const effectiveDate = text(d.effectiveDate, "Effective date", 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) || !Number.isFinite(Date.parse(effectiveDate)) || new Date(effectiveDate).toISOString().slice(0, 10) !== effectiveDate || effectiveDate < businessDate(now) || effectiveDate > lastEffectiveDate(now)) throw new Error("Choose an effective date between today and 90 days from today.");
  const data: Record<string, string | number> = { effectiveDate, nameInsured: text(d.nameInsured, "Insured name", 200) };
  // Every supplied optional value is validated; omitted answers stay omitted.
  if (d.buildingType) {
    if (d.buildingType !== "condominium") throw new Error("This workflow currently supports condominium associations.");
    data.buildingType = "condominium";
  }
  for (const [key, label, min, max, integer] of [
    ["grossSQFeet", "Building area", 500, Number.MAX_SAFE_INTEGER, false],
    ["replacementValue", "Replacement cost", 150000, 99999999, false],
    ["numUnits", "Unit count", 1, Number.MAX_SAFE_INTEGER, true],
    ["yearBuilt", "Year built", 1600, Number(businessDate(now).slice(0, 4)), true],
    ["numStories", "Stories", 1, 20, true],
  ] as const) {
    if (d[key] == null || d[key] === "") continue;
    const raw = String(d[key]).replaceAll(",", "").trim(), number = Number(raw);
    if (!/^\d+(\.\d+)?$/.test(raw) || !Number.isFinite(number) || number < min || number > max || (integer && !Number.isSafeInteger(number))) throw new Error(`${label} must be ${integer ? "a whole number" : "a number"} between ${min.toLocaleString("en-US")} and ${max.toLocaleString("en-US")}.`);
    data[key] = number;
  }
  let address = text(d.address, "Full property address", 800);
  if (estimate) {
    if (!eligibleEstimate(estimate)) throw new Error("Only an eligible Honeycomb estimate can be converted to a submission.");
    const original = object(estimate.input), originalData = object(original.submissionData);
    if (typeof original.address !== "string" || !original.address.trim() || originalData.buildingType !== "condominium" || typeof originalData.grossSQFeet !== "number" || typeof originalData.replacementValue !== "number") throw new Error("The estimate's original property data is missing. Review the property without linking this estimate.");
    address = original.address;
    // Re-send the entire exact estimation data. Never attach its ID to edited rating inputs.
    if (originalData.effectiveDate && originalData.effectiveDate !== effectiveDate) throw new Error("The effective date must match the linked estimate.");
    Object.assign(data, originalData);
  }
  const input: PartialInput = { address, ...(estimate ? { estimationId: estimate.estimationId! } : {}), submissionData: data };
  if (new TextEncoder().encode(JSON.stringify(input)).length > 16000) throw new Error("The submission data is too large.");
  return input;
}
export function portalUrl(submissionId: string): string | undefined {
  return /^[a-zA-Z0-9_-]{1,200}$/.test(submissionId) ? `https://staging-falcon.honeycombinsurance.com/quotes/${encodeURIComponent(submissionId)}` : undefined;
}
export function submissionStatus(record: Pick<SubmissionRecord, "status" | "updatedAt">, now = Date.now()): string {
  return record.status === "RUNNING" && now - Date.parse(record.updatedAt) > 120000 ? "UNKNOWN" : record.status;
}
