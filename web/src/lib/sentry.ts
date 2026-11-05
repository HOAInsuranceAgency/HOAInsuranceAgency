import * as Sentry from "@sentry/browser";
import { sanitizeSentryBreadcrumb, sanitizeSentryEvent } from "../../../shared/sentryPrivacy";
import { shouldInitializeSentry } from "./sentryPolicy";

interface MonitoringEnvironment {
  PROD: boolean;
  MODE: string;
  PUBLIC_SENTRY_DSN?: string;
  PUBLIC_SENTRY_ENABLED?: string;
  PUBLIC_SENTRY_ENVIRONMENT?: string;
  PUBLIC_SENTRY_RELEASE?: string;
}

/** Browser error monitoring only. No customer identity, replay, or tracing. */
export function initializeSentry(): void {
  const env = {
    PROD: import.meta.env.PROD,
    MODE: import.meta.env.MODE,
    PUBLIC_SENTRY_DSN: import.meta.env.PUBLIC_SENTRY_DSN,
    PUBLIC_SENTRY_ENABLED: import.meta.env.PUBLIC_SENTRY_ENABLED,
    PUBLIC_SENTRY_ENVIRONMENT: import.meta.env.PUBLIC_SENTRY_ENVIRONMENT,
    PUBLIC_SENTRY_RELEASE: import.meta.env.PUBLIC_SENTRY_RELEASE,
  };
  if (!shouldInitializeSentry(env, window.location.pathname) || Sentry.isInitialized()) return;
  Sentry.init(browserMonitoringOptions(env));
}

/** Export the actual options so transport tests exercise the production policy. */
export function browserMonitoringOptions(env: MonitoringEnvironment): Sentry.BrowserOptions {
  return {
    dsn: env.PUBLIC_SENTRY_DSN?.trim(),
    environment: env.PUBLIC_SENTRY_ENVIRONMENT?.trim() || env.MODE,
    release: env.PUBLIC_SENTRY_RELEASE?.trim() || undefined,
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
    defaultIntegrations: false,
    integrations: [
      Sentry.eventFiltersIntegration(),
      Sentry.browserApiErrorsIntegration(),
      Sentry.globalHandlersIntegration(),
      Sentry.linkedErrorsIntegration(),
      Sentry.dedupeIntegration(),
      Sentry.breadcrumbsIntegration({ dom: false, sentry: false }),
    ],
    tracePropagationTargets: [],
    beforeBreadcrumb: sanitizeSentryBreadcrumb,
    beforeSend: sanitizeSentryEvent,
    beforeSendLog: () => null,
    beforeSendMetric: () => null,
    tracesSampleRate: 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    profileSessionSampleRate: 0,
    sendClientReports: false,
    initialScope: { tags: { app: "web" } },
  };
}
