import { client } from "./client";
import { privateApiError, privateApiRecord, ApiResponseError } from './apiResponse';
import { communicationOperationMode } from '../../../shared/apiOperations';
import type { CommunicationReadOperation, CommunicationWriteOperation, CommunicationOperation, CommunicationInput, CommunicationResult } from './communicationContracts';
export type { CommunicationWriteOperation, CommunicationOperation, CommunicationInput, CommunicationResult } from './communicationContracts';
type OptionalRead = { [K in CommunicationReadOperation]: {} extends CommunicationInput<K> ? K : never }[CommunicationReadOperation];
export function communicationRequest<K extends OptionalRead>(operation: K, input?: CommunicationInput<K>, write?: false): Promise<CommunicationResult<K>>;
export function communicationRequest<K extends Exclude<CommunicationReadOperation, OptionalRead>>(operation: K, input: CommunicationInput<K>, write?: false): Promise<CommunicationResult<K>>;
export function communicationRequest<K extends CommunicationWriteOperation>(operation: K, input: CommunicationInput<K>, write: true): Promise<CommunicationResult<K>>;
export async function communicationRequest(operation: CommunicationOperation, input: CommunicationInput<CommunicationOperation> = {}, write = false): Promise<unknown> {
  if (communicationOperationMode(operation) !== (write ? 'write' : 'read')) throw new ApiResponseError('Unknown operation or incorrect API transport.', { code: 'INVALID_API_OPERATION' });
  const response = await (write
    ? client.mutations.communicationWrite({ operation, input: JSON.stringify(input) })
    : client.queries.communicationRead({ readOperation: operation, input: JSON.stringify(input) })).catch(privateApiError);
  const result = privateApiRecord(response, { fallback: 'The request could not be completed' });
  return result;
}
export type { LeadWorkflow, LeadTask, TeamEligibility, IntegrationConfig, Communication, WorkflowContext } from "../../../shared/leadWorkflow";
