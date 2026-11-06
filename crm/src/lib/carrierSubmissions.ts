import { client } from './client';
import { privateApiCall } from './apiResponse';
import type { ApiRecord } from '../../../shared/apiResponse';

export async function readSubmissionSettings() {
  return await privateApiCall(client.queries.honeycombSubmissionSettings(),
    (value): value is ApiRecord & { enabled: boolean; environment: string } => typeof value.enabled === 'boolean' && typeof value.environment === 'string',
    { requireOk: false, fallback: 'Could not load carrier submission settings.' });
}
export async function startCarrierSubmission(input: { accountId: string; details: string; sourceEstimateId?: string; reviewed: boolean; retryVersion?: string | null }) {
  return await privateApiCall(client.mutations.startHoneycombSubmission(input),
    (value): value is ApiRecord & { id: string } => typeof value.id === 'string' && !!value.id,
    { fallback: 'Could not confirm the request. Refresh submission history before trying again.' });
}
export async function resolveCarrierSubmission(input: { id: string; outcome: string; submissionId?: string; note: string; reviewed: boolean }): Promise<void> {
  await privateApiCall(client.mutations.resolveHoneycombSubmission(input),
    (value): value is ApiRecord & { ok: true } => value.ok === true,
    { fallback: 'Could not save the review. Refresh and try again.' });
}
