import * as Sentry from "@sentry/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sanitizeSentryBreadcrumb, sanitizeSentryEvent } from "../../../shared/sentryPrivacy";
import { initializeMonitoring } from "./monitoring";

vi.mock("@sentry/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sentry/react")>()),
  init: vi.fn(),
}));

const dsn = "https://public@o0.ingest.sentry.io/1";

beforeEach(() => vi.clearAllMocks());

describe("monitoring opt-in", () => {
  it.each([
    { PROD: true, MODE: "production" },
    { PROD: true, MODE: "production", VITE_SENTRY_DSN: "  " },
    { PROD: false, MODE: "development", VITE_SENTRY_DSN: dsn },
    { PROD: false, MODE: "development", VITE_SENTRY_DSN: dsn, VITE_SENTRY_ENABLED: "false" },
    { PROD: true, MODE: "production", VITE_SENTRY_ENABLED: "true" },
  ])("leaves the SDK uninitialized for an unconfigured or local build", (env) => {
    expect(initializeMonitoring(env)).toBe(false);
    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it("sends deployed errors with the matching environment and release", () => {
    expect(initializeMonitoring({
      PROD: true, MODE: "production", VITE_SENTRY_DSN: ` ${dsn} `,
      VITE_SENTRY_ENVIRONMENT: " staging ", VITE_SENTRY_RELEASE: " commit-sha ",
    })).toBe(true);
    const options = vi.mocked(Sentry.init).mock.calls[0][0];
    expect(options).toMatchObject({
      dsn, environment: "staging", release: "commit-sha",
      defaultIntegrations: false,
      beforeSend: sanitizeSentryEvent,
      beforeBreadcrumb: sanitizeSentryBreadcrumb,
      dataCollection: {
        userInfo: false, cookies: false, httpHeaders: false,
        httpBodies: [], urlQueryParams: false,
        graphQL: { document: false, variables: false },
        stackFrameVariables: false,
      },
    });
    const integrations = (options.integrations as { name: string }[]).map(item => item.name);
    for (const name of ["Console", "Replay", "BrowserTracing", "BrowserProfiling", "ConsoleLogs"]) {
      expect(integrations).not.toContain(name);
    }
    expect(options.beforeSendLog?.({} as never)).toBeNull();
    expect(options.beforeSendMetric?.({} as never)).toBeNull();
    expect(options.tracesSampleRate).toBe(0);
  });

  it("permits an explicit local smoke test and falls back to the build mode", () => {
    initializeMonitoring({
      PROD: false, MODE: "development", VITE_SENTRY_DSN: dsn,
      VITE_SENTRY_ENABLED: "true", VITE_SENTRY_ENVIRONMENT: " ",
    });
    expect(Sentry.init).toHaveBeenCalledWith(expect.objectContaining({ environment: "development" }));
  });
});
