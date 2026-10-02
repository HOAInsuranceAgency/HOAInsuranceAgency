// Access-denied responses can arrive as SDK errors, AppSync error objects, or
// the account guard's message after a Lambda boundary strips the error type.
export function isAuthorizationError(error: unknown): boolean {
  const envelope = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  // Amplify can also reject with a GraphQL envelope instead of returning it.
  const errors = [error, ...(Array.isArray(envelope.errors) ? envelope.errors : [])];
  return errors.some(item => {
    const value = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const type = /(?:^|:)(?:Unauthorized|NotAuthorized|Forbidden|AccessDenied|UserUnAuthenticated|NoSignedUser|NoValidAuthTokens)(?:Exception)?$/i;
    if ([value.name, value.code, value.errorType].some(code => typeof code === 'string' && type.test(code))) return true;
    const message = typeof item === 'string' ? item : typeof value.message === 'string' ? value.message : '';
    return /\b(?:not authori[sz]ed|unauthori[sz]ed|forbidden|access denied)\b|This record is not available to your account|You don't have permission/i.test(message);
  });
}
