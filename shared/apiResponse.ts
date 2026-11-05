/** Wire helpers only: no SDK, browser state, authorization policy, or retries. */
export type ApiRecord = Record<string, unknown>;
export interface ApiIssue {
  message: string;
  code?: string;
  errorType?: string;
  name?: string;
}
export interface ApiResponse { data?: unknown; errors?: readonly unknown[] }
export interface ApiFailure { ok: false; error: string; code?: string; errorType?: string }

export function isRecord(value: unknown): value is ApiRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
/** Transport validation only; service-specific host/path authorization stays with its owner. */
export function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
}

/** AWSJSON can contain the writer's JSON string inside its wire JSON string. */
export function decodeAwsJson(value: unknown): unknown {
  for (let depth = 0; depth < 2 && typeof value === 'string'; depth++) value = JSON.parse(value);
  return value;
}

/** Retain safe classification fields, never response payloads or arbitrary extensions. */
export function apiIssue(value: unknown, fallback: string): ApiIssue {
  const source = isRecord(value) ? value : {};
  return {
    message: typeof source.message === 'string' && source.message ? source.message : typeof value === 'string' && value ? value : fallback,
    ...(typeof source.code === 'string' ? { code: source.code } : {}),
    ...(typeof source.errorType === 'string' ? { errorType: source.errorType } : {}),
    ...(typeof source.name === 'string' ? { name: source.name } : {}),
  };
}

export class ApiResponseError extends Error {
  readonly errors: readonly ApiIssue[];
  declare readonly code?: string;
  declare readonly errorType?: string;
  readonly origin: 'application' | 'graphql' | 'transport' | 'protocol';
  constructor(message: string, options: { errors?: readonly ApiIssue[]; code?: string; errorType?: string; origin?: ApiResponseError['origin'] } = {}) {
    super(message);
    this.name = 'ApiResponseError';
    this.errors = options.errors ?? [];
    if (options.code !== undefined) this.code = options.code;
    if (options.errorType !== undefined) this.errorType = options.errorType;
    this.origin = options.origin ?? 'protocol';
  }
}

export function assertApiErrors(response: Pick<ApiResponse, 'errors'>, fallback = 'The request could not be completed.'): void {
  if (!response.errors?.length) return;
  const errors = response.errors.map(error => apiIssue(error, fallback));
  throw new ApiResponseError(errors.map(error => error.message).join('; '), {
    // A transport code is evidence, never proof that a business write was not dispatched.
    errors, origin: 'graphql', errorType: errors.find(error => error.errorType)?.errorType,
  });
}

export function apiFailure(error: unknown, fallback: string): ApiFailure {
  const issue = apiIssue(error, fallback);
  return { ok: false, error: issue.message, ...(issue.code ? { code: issue.code } : {}), ...(issue.errorType ? { errorType: issue.errorType } : {}) };
}

export interface DecodeOptions {
  fallback: string;
  invalid?: string;
  /** Model counters and scoped file responses do not carry an ok flag. */
  requireOk?: boolean;
}

export function decodeApiRecord(response: ApiResponse, options: DecodeOptions): ApiRecord {
  assertApiErrors(response, options.fallback);
  let value: unknown;
  try { value = decodeAwsJson(response.data); }
  catch { throw new ApiResponseError(options.invalid ?? options.fallback, { code: 'INVALID_API_RESPONSE' }); }
  if (!isRecord(value)) throw new ApiResponseError(options.invalid ?? options.fallback, { code: 'INVALID_API_RESPONSE' });
  if (value.ok === false || options.requireOk !== false && value.ok !== true) {
    throw new ApiResponseError(typeof value.error === 'string' && value.error ? value.error : options.fallback, {
      origin: 'application',
      code: typeof value.code === 'string' ? value.code : undefined,
      errorType: typeof value.errorType === 'string' ? value.errorType : undefined,
      errors: [apiIssue({ ...value, message: value.error }, options.fallback)],
    });
  }
  return value;
}

export function decodeApiResponse<T>(response: ApiResponse, validate: (value: ApiRecord) => value is T & ApiRecord, options: DecodeOptions): T {
  const value = decodeApiRecord(response, options);
  if (!validate(value)) throw new ApiResponseError(options.invalid ?? options.fallback, { code: 'INVALID_API_RESPONSE' });
  return value;
}
