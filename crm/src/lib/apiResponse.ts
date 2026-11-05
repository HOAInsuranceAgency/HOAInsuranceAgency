import { ApiResponseError, apiIssue, assertApiErrors, decodeApiRecord, type ApiRecord, type ApiResponse, type DecodeOptions } from '../../../shared/apiResponse';
import { isAuthorizationError } from '../../../shared/authorizationError';
export { ApiResponseError, isRecord } from '../../../shared/apiResponse';

/** Private CRM classification is separate from public website error disclosure. */
export function privateApiError(error: unknown): never {
  const source = error && typeof error === 'object' ? error as { errors?: unknown } : {};
  const issues = Array.isArray(source.errors) && source.errors.length ? source.errors.map(value => apiIssue(value, 'The request could not be completed.')) : [apiIssue(error, 'The request could not be completed.')];
  const normalized = new ApiResponseError(issues.map(issue => issue.message).join('; '), {
    errors: issues, origin: 'transport', errorType: issues.find(issue => issue.errorType)?.errorType,
  });
  if (isAuthorizationError(error)) normalized.name = 'Unauthorized';
  throw normalized;
}

export function assertGraphqlErrors(response: Pick<ApiResponse, 'errors'>, fallback?: string): void {
  try { assertApiErrors(response, fallback); } catch (error) { decodedApiError(error); }
}

/** Preserve origin only after this boundary has decoded the returned response. */
function decodedApiError(error: unknown): never {
  if (error instanceof ApiResponseError) {
    if (isAuthorizationError(error)) error.name = 'Unauthorized';
    throw error;
  }
  return privateApiError(error);
}

export function privateApiRecord(response: ApiResponse, options: DecodeOptions) {
  try { return decodeApiRecord(response, options); } catch (error) {
    // Only this decoder has inspected an application response. SDK rejections
    // always go through privateApiError and cannot assert nondispatch.
    return decodedApiError(error);
  }
}

export function privateApiResponse<T>(response: ApiResponse, validate: (value: ApiRecord) => value is T & ApiRecord, options: DecodeOptions): T {
  const value = privateApiRecord(response, options);
  if (!validate(value)) throw new ApiResponseError(options.invalid ?? options.fallback, { code: 'INVALID_API_RESPONSE' });
  return value;
}

export async function privateApiCall<T>(response: Promise<ApiResponse>, validate: (value: ApiRecord) => value is T & ApiRecord, options: DecodeOptions): Promise<T> {
  return privateApiResponse(await response.catch(privateApiError), validate, options);
}
