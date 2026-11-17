import { payrollRowKey, type PayrollWorkspace } from "../../../shared/commissionPayroll";
/** Follow explicit source links, never employee identity alone. Adjustments have their own review. */
export function sourcePayrollHandoff(workspace: PayrollWorkspace, intakeId: string) {
  const links = workspace.sourceLinks?.filter(l => l.intakeId === intakeId) ?? [];
  const belongs = (r: { policyId: string; entryId: string; source?: string }) => r.source !== "ADJUSTMENT" && links.some(l => l.policyId === r.policyId && l.entryId === r.entryId);
  const available = (workspace.availableEarnings ?? []).filter(belongs);
  const keys = available.map(payrollRowKey);
  const batches = workspace.batches.filter(b => b.status !== "CANCELLED" && b.lines.some(belongs) && workspace.cycles.some(c => c.status !== "CANCELLED" && c.batchIds.includes(b.id)));
  const linkedCycles = workspace.cycles.filter(c => c.status !== "CANCELLED" && (batches.some(b => c.batchIds.includes(b.id)) || (c.status === "OPEN" && !!keys.length && c.selectedEarningKeys?.length === keys.length && c.selectedEarningKeys.every(k => keys.includes(k)))));
  const latestReceipt = available.map(r => r.receivedOn).sort().at(-1);
  const monthly = latestReceipt ? workspace.cycles.filter(c => c.status === "OPEN" && c.cycleType !== "OFF_CYCLE" && !c.id.includes("-OFF-") && c.cutoff >= latestReceipt).sort((a,b) => a.cutoff.localeCompare(b.cutoff))[0] : undefined;
  return { available, keys, linkedCycles, monthly, latestReceipt };
}
