import * as Sentry from "@sentry/react";
import { sanitizeSentryBreadcrumb, sanitizeSentryEvent } from "../../../shared/sentryPrivacy";

interface MonitoringEnvironment {
  PROD: boolean;
  MODE: string;
  VITE_SENTRY_DSN?: string;
  VITE_SENTRY_ENVIRONMENT?: string;
  VITE_SENTRY_RELEASE?: string;
  VITE_SENTRY_ENABLED?: string;
}

/** No SDK instrumentation or network traffic until this build opts in. */
export function initializeMonitoring(env: MonitoringEnvironment): boolean {
  const dsn = env.VITE_SENTRY_DSN?.trim();
  if (!dsn || (!env.PROD && env.VITE_SENTRY_ENABLED !== "true")) return false;

  Sentry.init({
    dsn,
    environment: env.VITE_SENTRY_ENVIRONMENT?.trim() || env.MODE,
    release: env.VITE_SENTRY_RELEASE?.trim() || undefined,
    // Keep automatic error capture while opting in only to integrations that
    // cannot record console arguments, DOM text, replay, logs or performance.
    defaultIntegrations: false,
    integrations: [
      Sentry.eventFiltersIntegration(),
      Sentry.browserApiErrorsIntegration(),
      Sentry.globalHandlersIntegration(),
      Sentry.linkedErrorsIntegration(),
      Sentry.dedupeIntegration(),
      Sentry.breadcrumbsIntegration({ dom: false, sentry: false }),
    ],
    // Sentry 11 replaces sendDefaultPii with per-category collection controls.
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
    tracePropagationTargets: [],
    tracesSampleRate: 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    profileSessionSampleRate: 0,
    sendClientReports: false,
    initialScope: { tags: { app: "crm" } },
    beforeSend: sanitizeSentryEvent,
    beforeBreadcrumb: sanitizeSentryBreadcrumb,
    beforeSendLog: () => null,
    beforeSendMetric: () => null,
  });
  return true;
}
