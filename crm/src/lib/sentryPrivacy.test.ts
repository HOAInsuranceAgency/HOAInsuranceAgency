import { describe, expect, it } from "vitest";
import { sanitizeSentryBreadcrumb, sanitizeSentryEvent } from "../../../shared/sentryPrivacy";

describe("Sentry diagnostic privacy", () => {
  it("omits customer data and token URLs while retaining symbolication and grouping", () => {
    const event = {
      event_id: "abc123", release: "hoa-crm@123", environment: "staging",
      user: { email: "customer@example.com", id: "private-customer" },
      message: "Payment token secret-payment", extra: { document: "private-document" },
      contexts: { request: { authorization: "Bearer secret-auth" } },
      transaction: "/documents/secret-upload?t=secret-query",
      request: { url: "https://example.com/documents/secret-upload?t=secret-query#secret-hash", headers: { authorization: "secret-auth" }, data: "private-body" },
      tags: { app: "hoa-crm", email: "customer@example.com" },
      exception: { values: [{ type: "TypeError", value: "Cannot read customer@example.com with secret-payment", stacktrace: { frames: [{
        filename: "https://user:password@example.com/assets/app-123.js?t=secret-query#secret-hash", lineno: 12, colno: 34, function: "savePolicy",
        vars: { password: "secret-auth" }, pre_context: ["private-document"], context_line: "private-body",
      }] }, mechanism: { type: "onunhandledrejection", handled: false, data: { token: "secret-payment" } } }] },
      breadcrumbs: [ { category: "console", message: "private-body" }, { category: "ui.click", message: "customer@example.com" },
        { category: "fetch", data: { url: "https://example.com/customer/private-customer?t=secret-query", method: "POST", status_code: 500, body: "private-body" } } ],
      debug_meta: { images: [{ type: "sourcemap", debug_id: "debug123", code_file: "https://example.com/assets/app-123.js?secret-query" }] },
    };
    const sanitized = sanitizeSentryEvent(event);
    const serialized = JSON.stringify(sanitized);
    for (const text of ["customer@example.com", "private-", "secret-", "password", "Bearer"]) expect(serialized).not.toContain(text);
    expect(sanitized.exception.values[0].stacktrace?.frames?.[0]).toMatchObject({ filename: "https://example.com/assets/app-123.js", lineno: 12, colno: 34, function: "savePolicy" });
    expect(sanitized.exception.values[0].mechanism).toMatchObject({ handled: false, type: "onunhandledrejection" });
    expect(sanitized.debug_meta.images[0].debug_id).toBe("debug123");
    expect(sanitized.request).toEqual({ url: "https://example.com" });
    expect(sanitized.tags).toEqual({ app: "hoa-crm" });
    expect(event.user.email).toBe("customer@example.com");
  });

  it("discards arbitrary breadcrumbs and URL schemes", () => {
    expect(sanitizeSentryBreadcrumb({ category: "navigation", data: { to: "?t=secret" } })).toBeNull();
    const event = sanitizeSentryEvent({ request: { url: "javascript:alert('secret')" }, exception: { values: [{ type: "Error", value: "secret" }] } });
    expect(JSON.stringify(event)).not.toContain("secret");
  });

  it("keeps original Lambda source locations without exposing build-machine paths", () => {
    for (const filename of ["/Users/private-builder/work/crm/amplify/functions/lead-intake/handler.ts", "file:///build/crm/amplify/functions/lead-intake/handler.ts", "app:///amplify/functions/lead-intake/handler.ts"]) {
      const result = sanitizeSentryEvent({ exception: { values: [{ stacktrace: { frames: [{ filename, lineno: 42 }] } }] } });
      expect(result.exception.values[0].stacktrace.frames[0].filename).toBe("app:///amplify/functions/lead-intake/handler.ts");
    }
  });
});
