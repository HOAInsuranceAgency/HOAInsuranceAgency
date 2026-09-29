/** Cached clients cannot reactivate CRM tasks or daily staff reports. */
export const RETIRED_TASK_OPERATIONS = new Set([
  "saveTask", "completeTask", "mergeTasks", "updateBlocker", "takeResponse", "delegateService",
  "requestProspectInformation", "requestChampionHelp", "deliveryOptions", "nextYear", "nextYearPreview",
  "myReport", "reportDelivery", "recoverReport", "teamRouting", "saveTeamRouting",
]);

export function retiredTaskOperation(operation: string, input: { kind?: unknown; taskId?: unknown } = {}) {
  return RETIRED_TASK_OPERATIONS.has(operation)
    || operation === "work" && ["", "TASK", "NOTIFICATION"].includes(String(input.kind ?? "").trim())
    || operation === "recordCallOutcome" && !!input.taskId;
}
