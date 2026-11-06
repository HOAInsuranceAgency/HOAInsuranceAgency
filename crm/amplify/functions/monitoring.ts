import * as Sentry from "@sentry/aws-serverless";
import type { Context, Handler } from "aws-lambda";
import { sanitizeSentryEvent } from "../../../shared/sentryPrivacy";

// Error identity is trusted local state, never an event field or a matching
// message. It cannot be supplied by an incoming payload or another exception.
const repeatedCommunicationHealthErrors = new WeakSet<Error>();

// No request, AWS SDK, console or local-variable instrumentation. Only the
// explicit handler wrapper below records failures; customer events never enter
// a Sentry scope. An absent DSN preserves the original function with no wrapper.
const enabled = Boolean(process.env.SENTRY_DSN);
if (enabled) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? "development",
    release: process.env.SENTRY_RELEASE,
    defaultIntegrations: false,
    enableOpenTelemetrySetup: false,
    enableRuntimeChannelInjection: false,
    tracesSampleRate: 0,
    profileSessionSampleRate: 0,
    maxBreadcrumbs: 0,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    beforeSend: (event, hint) => {
      if (hint?.originalException instanceof Error && repeatedCommunicationHealthErrors.has(hint.originalException)) return null;
      return sanitizeSentryEvent(
        event.message?.startsWith("Possible function timeout:")
          ? { ...event, exception: { values: [{ ...event.exception?.values?.[0], type: "LambdaTimeoutWarning" }] } }
          : event,
      );
    },
    beforeSendLog: () => null,
    beforeSendMetric: () => null,
    beforeBreadcrumb: () => null,
  });
}

/** Public destination identity only; a project/environment cutover reports anew. */
export function communicationHealthSentryTarget(): string | undefined {
  if (!enabled || !Sentry.isEnabled()) return undefined;
  const client = Sentry.getClient(), dsn = client?.getDsn();
  if (!dsn) return undefined;
  return JSON.stringify([dsn.protocol, dsn.host, dsn.port ?? "", dsn.path ?? "", dsn.projectId, client?.getOptions().environment ?? "development"]);
}

/** Called only for the known health Error after duplicate state was saved. */
export function markRepeatedCommunicationHealthError(error: Error): void {
  repeatedCommunicationHealthErrors.add(error);
}

function resultFailure(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const value = result as Record<string, unknown>;
  if (typeof value.statusCode === "number" && value.statusCode >= 500) return "http_server_error";
  if (Array.isArray(value.batchItemFailures) && value.batchItemFailures.length > 0) return "batch_item_failure";
  if (typeof value.failed === "number" && value.failed > 0) return "worker_item_failure";
  return undefined;
}

/** Record an unexpected job failure that the worker saves instead of rethrowing. */
export function captureHandledFailure(error: unknown): void {
  if (enabled) Sentry.captureException(error, { tags: { failure_kind: "handled_job_failure" } });
}

/**
 * Keep business handlers independently testable and preserve their return/retry
 * contracts. Every deployed entry module invokes this once with a static name.
 * Expected validation/auth failures returned as { ok:false } are not captured.
 */
export function monitorHandler<T extends (...args: any[]) => any>(handler: T, name: string): T {
  if (!enabled) return handler;
  return (async (...args: Parameters<T>) => {
    const context = args[1] as Context;
    return Sentry.withIsolationScope(async (scope) => {
      scope.setTag("app", "backend");
      scope.setTag("function", name);
      // The SDK supplies timeout warnings, unhandled exception capture and a
      // bounded flush before Lambda freezes. Preserve the caller's event-loop
      // setting instead of adopting the SDK's default change to it.
      const wrapped = Sentry.wrapHandler(handler as Handler, {
        callbackWaitsForEmptyEventLoop: context.callbackWaitsForEmptyEventLoop,
        captureTimeoutWarning: true,
        timeoutWarningLimit: 1_000,
        captureAllSettledReasons: false,
        flushTimeout: 1_000,
      });
      const result = await wrapped(args[0], context, args[2]);
      const kind = resultFailure(result);
      if (kind) {
        // Do not attach the result, batch identifiers, response body or input.
        const error = new Error("Lambda returned a failure result");
        error.name = "LambdaResultFailure";
        Sentry.captureException(error, {
          tags: { failure_kind: kind },
          fingerprint: ["hoa-lambda-result", name, kind],
        });
        await Sentry.flush(1_000).catch(() => false);
      }
      return result;
    });
  }) as T;
}
