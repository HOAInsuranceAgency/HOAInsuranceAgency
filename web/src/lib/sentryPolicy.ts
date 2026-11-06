/** Token-bearing pages must never initialize a third-party monitoring client. */
export function canMonitorPage(pathname: string): boolean {
  return !/^\/(documents|finance|broker-fee)(?:\/|$)/i.test(pathname);
}

export function shouldInitializeSentry(
  env: { PROD?: boolean; PUBLIC_SENTRY_DSN?: string; PUBLIC_SENTRY_ENABLED?: string },
  pathname: string,
): boolean {
  return Boolean(
    env.PUBLIC_SENTRY_DSN?.trim() &&
    (env.PROD || env.PUBLIC_SENTRY_ENABLED === "true") &&
    canMonitorPage(pathname),
  );
}
