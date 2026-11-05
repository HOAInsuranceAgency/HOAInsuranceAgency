import assert from "node:assert/strict";
import test from "node:test";
import { canMonitorPage, shouldInitializeSentry } from "../src/lib/sentryPolicy";
import * as Sentry from "@sentry/browser";
import { createServer } from "vite";

test("token routes are excluded even with a production DSN or explicit local enablement", () => {
  for (const pathname of ["/documents", "/documents/", "/finance/", "/broker-fee/", "/documents/upload", "/FINANCE/"]) {
    assert.equal(canMonitorPage(pathname), false, pathname);
    assert.equal(shouldInitializeSentry({ PROD: true, PUBLIC_SENTRY_DSN: "https://public@example.com/1" }, pathname), false);
    assert.equal(shouldInitializeSentry({ PUBLIC_SENTRY_ENABLED: "true", PUBLIC_SENTRY_DSN: "https://public@example.com/1" }, pathname), false);
  }
});

test("monitoring requires a DSN and production build or explicit local opt-in", () => {
  const dsn = "https://public@example.com/1";
  assert.equal(shouldInitializeSentry({ PROD: true }, "/quote/"), false);
  assert.equal(shouldInitializeSentry({ PROD: true, PUBLIC_SENTRY_DSN: "  " }, "/quote/"), false);
  assert.equal(shouldInitializeSentry({ PUBLIC_SENTRY_DSN: dsn }, "/quote/"), false);
  assert.equal(shouldInitializeSentry({ PROD: true, PUBLIC_SENTRY_DSN: dsn }, "/quote/"), true);
  assert.equal(shouldInitializeSentry({ PUBLIC_SENTRY_DSN: dsn, PUBLIC_SENTRY_ENABLED: "true" }, "/quote/"), true);
});

test("the browser SDK emits only sanitized error envelopes through the configured transport", async () => {
  // Use Vite's TS loading, as in Astro, for the shared module outside web/.
  const server = await createServer({ configFile: false, server: { middlewareMode: true } });
  const { browserMonitoringOptions } = await server.ssrLoadModule("/src/lib/sentry.ts");
  const envelopes: unknown[] = [];
  const options = browserMonitoringOptions({
    PROD: true,
    MODE: "production",
    PUBLIC_SENTRY_DSN: "https://public@example.com/1",
    PUBLIC_SENTRY_ENVIRONMENT: "test",
    PUBLIC_SENTRY_RELEASE: "web-test-release",
  });
  Sentry.init({
    ...options,
    transport: () => ({
      send: async (envelope) => { envelopes.push(envelope); return { statusCode: 200 }; },
      flush: async () => true,
    }),
  });
  try {
    Sentry.setUser({ email: "private-customer@example.com" });
    Sentry.addBreadcrumb({ category: "ui.click", message: "private-customer-name" });
    Sentry.addBreadcrumb({ category: "fetch", data: { url: "https://example.com/documents/private-customer?t=private-token", method: "POST", body: "private-body" } });
    Sentry.captureException(new TypeError("private-customer@example.com private-token"), {
      extra: { customer: "private-customer" },
    });
    await Sentry.flush(1_000);
    const items = envelopes.flatMap((envelope: any) => envelope[1]);
    assert.equal(items.length, 1);
    assert.equal(items[0][0].type, "event");
    const event = items[0][1];
    assert.equal(event.exception.values[0].type, "TypeError");
    assert.equal(event.release, "web-test-release");
    assert.deepEqual(event.tags, { app: "web" });
    assert.equal(event.breadcrumbs[0].data.url, "https://example.com");
    assert.doesNotMatch(JSON.stringify(envelopes), /private-/);
    assert.equal(options.defaultIntegrations, false);
    assert.deepEqual((options.integrations as { name: string }[]).map((i) => i.name), [
      "EventFilters", "BrowserApiErrors", "GlobalHandlers", "LinkedErrors", "Dedupe", "Breadcrumbs",
    ]);
    assert.deepEqual(options.tracePropagationTargets, []);
  } finally {
    await Sentry.close(100);
    await server.close();
  }
});
