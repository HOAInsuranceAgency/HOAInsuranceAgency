import type { LeadTask } from "./leadWorkflow";
export const BLOCKER_REASONS = ["Licensing pending", "Carrier access needed", "Carrier decision pending", "Required information missing"] as const;
export function canRecordBlocker(task: Pick<LeadTask, "milestone" | "kind">) {
  return !!task.milestone || ["CARRIER", "DOCUMENTS"].includes(task.kind);
}
