import { client } from "./client";
import { isAuthorizationError } from './authorizationError';
export async function communicationRequest<T>(operation: string, input: unknown = {}, write = false): Promise<T> {
  const response = await (write
    ? client.mutations.communicationWrite({ operation, input: JSON.stringify(input) })
    : client.queries.communicationRead({ readOperation: operation, input: JSON.stringify(input) })).catch(error => {
      if (isAuthorizationError(error) && !(error instanceof Error)) {
        throw Object.assign(new Error("You don't have permission to do that."), { name: 'Unauthorized' });
      }
      throw error;
    });
  if (response.errors?.length) {
    const denied = response.errors.find(isAuthorizationError);
    const error = new Error((denied ?? response.errors[0]).message);
    // Preserve authorization classification across the GraphQL-to-Error boundary,
    // even when another field's transient error appears first in the response.
    if (denied) error.name = 'Unauthorized';
    throw error;
  }
  const result = typeof response.data === "string" ? JSON.parse(response.data) : response.data;
  if (!result || typeof result !== "object" || !(result as { ok?: boolean }).ok) throw new Error((result as { error?: string } | null)?.error ?? "The request could not be completed");
  return result as T;
}
export type { LeadWorkflow, LeadTask, TeamEligibility, IntegrationConfig, Communication, WorkflowContext } from "../../../shared/leadWorkflow";
