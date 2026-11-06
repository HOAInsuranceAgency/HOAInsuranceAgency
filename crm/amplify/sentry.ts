type BackendResource = { addEnvironment?: (key: string, value: string) => unknown; resources?: { lambda?: unknown } };

/** Synth-time only: keep this module independent from Lambda/browser code. */
export function configureSentry(
  backend: Record<string, unknown>,
  options: { preview: boolean; environment: string },
) {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn || options.preview) return;
  for (const value of Object.values(backend)) {
    if (!value || typeof value !== "object") continue;
    const resource = value as BackendResource;
    if (!resource.resources?.lambda || typeof resource.addEnvironment !== "function") continue;
    resource.addEnvironment("SENTRY_DSN", dsn);
    resource.addEnvironment("SENTRY_ENVIRONMENT", process.env.SENTRY_ENVIRONMENT ?? options.environment);
    const release = process.env.SENTRY_RELEASE ?? process.env.AWS_COMMIT_ID;
    if (release) resource.addEnvironment("SENTRY_RELEASE", release);
    // Amplify bundles private Lambda source maps. Let Node resolve original
    // stack locations locally; source contents are stripped by beforeSend.
    resource.addEnvironment("NODE_OPTIONS", "--enable-source-maps");
  }
}
