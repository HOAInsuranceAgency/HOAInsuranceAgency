import { client } from "./client";
export async function communicationRequest<T>(operation: string, input: unknown = {}, write = false): Promise<T> {
  const response = write
    ? await client.mutations.communicationWrite({ operation, input: JSON.stringify(input) })
    : await client.queries.communicationRead({ readOperation: operation, input: JSON.stringify(input) });
  if (response.errors?.length) throw new Error(response.errors[0].message);
  const result = typeof response.data === "string" ? JSON.parse(response.data) : response.data;
  if (!result || typeof result !== "object" || !(result as { ok?: boolean }).ok) throw new Error((result as { error?: string } | null)?.error ?? "The request could not be completed");
  return result as T;
}
export type { LeadWorkflow, LeadTask, TeamEligibility, IntegrationConfig, Communication, WorkflowContext } from "../../../shared/leadWorkflow";
