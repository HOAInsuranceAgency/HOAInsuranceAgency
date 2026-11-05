type StorageFailure = Error & { CancellationReasons?: { Code?: string }[]; $retryable?: unknown; $metadata?: { httpStatusCode?: number } };
/** Classification only. A financial command decides whether/how to recover. */
export function conditionalConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'ConditionalCheckFailedException') return true;
  if (error.name !== 'TransactionCanceledException') return false;
  const reasons = (error as StorageFailure).CancellationReasons;
  return !!reasons?.some(reason => reason.Code === 'ConditionalCheckFailed') &&
    reasons.every(reason => reason.Code === 'None' || reason.Code === 'ConditionalCheckFailed');
}
export function retryableStorageFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const failure = error as StorageFailure;
  if (failure.$retryable || (failure.$metadata?.httpStatusCode ?? 0) >= 500) return true;
  if (['ProvisionedThroughputExceededException', 'ThrottlingException', 'ThrottlingError', 'RequestLimitExceeded', 'TransactionConflictException', 'InternalServerError', 'ServiceUnavailable', 'TimeoutError'].includes(error.name)) return true;
  return error.name === 'TransactionCanceledException' && (!failure.CancellationReasons?.length ||
    failure.CancellationReasons.some(reason => ['TransactionConflict', 'ThrottlingError', 'ProvisionedThroughputExceeded'].includes(reason.Code ?? '')));
}
