// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Context } from "aws-lambda";
import { configureSentry } from "../../amplify/sentry";
import ts from 'typescript';

function monitoredEntrypoint(text: string): boolean {
  const source = ts.createSourceFile('entry.ts', text, ts.ScriptTarget.Latest, true);
  return source.statements.some(statement => ts.isVariableStatement(statement)
    && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
    && statement.declarationList.declarations.some(declaration => {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'handler') return false;
      const call = declaration.initializer;
      if (!call || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== 'monitorHandler') return false;
      const business = call.arguments[0];
      return !!business && (ts.isIdentifier(business) && business.text === 'originalHandler'
        || ts.isCallExpression(business) && ts.isIdentifier(business.expression) && business.expression.text === 'batchLiveChanges'
          && business.arguments.length === 1 && ts.isIdentifier(business.arguments[0]) && business.arguments[0].text === 'originalHandler');
    }));
}

const transport = vi.hoisted(() => ({ envelopes: [] as unknown[], initOptions: undefined as any }));
vi.mock("@sentry/aws-serverless", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sentry/aws-serverless")>();
  return {
    ...actual,
    init: (options: Parameters<typeof actual.init>[0]) => {
      transport.initOptions = options;
      return actual.init({
        ...options,
        transport: () => ({
          send: async (envelope) => { transport.envelopes.push(envelope); return { statusCode: 200 }; },
          flush: async () => true,
        }),
      });
    },
  };
});

const context = (): Context => ({
  callbackWaitsForEmptyEventLoop: true,
  functionName: "test-function",
  functionVersion: "$LATEST",
  invokedFunctionArn: "arn:aws:lambda:us-east-1:123456789012:function:test-function",
  memoryLimitInMB: "512",
  awsRequestId: "private-request-id",
  logGroupName: "private-log-group",
  logStreamName: "private-log-stream",
  getRemainingTimeInMillis: () => 30_000,
  done: () => {}, fail: () => {}, succeed: () => {},
});
const events = () => transport.envelopes.flatMap((envelope: any) => envelope[1]
  .filter((item: any) => item[0].type === "event").map((item: any) => item[1]));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("SENTRY_DSN", "https://public@example.com/1");
  vi.stubEnv("SENTRY_ENVIRONMENT", "test");
  vi.stubEnv("SENTRY_RELEASE", "test-release");
  transport.envelopes.length = 0;
  transport.initOptions = undefined;
});
afterEach(async () => {
  const sdk = await import("@sentry/aws-serverless");
  await sdk.close(100);
  vi.unstubAllEnvs();
});

describe("Lambda monitoring delivery contract", () => {
  it("does no SDK initialization or wrapping when no DSN is configured", async () => {
    vi.stubEnv("SENTRY_DSN", "");
    const { monitorHandler } = await import("../../amplify/functions/monitoring");
    const original = async () => ({ ok: true });
    expect(monitorHandler(original, "test-handler")).toBe(original);
    expect(transport.initOptions).toBeUndefined();
  });

  it("preserves result identity, arguments and the event-loop setting without recording payloads", async () => {
    const { monitorHandler } = await import("../../amplify/functions/monitoring");
    const result = { ok: true, customer: "private-customer-record" };
    const original = vi.fn(async (_event: unknown, _context: Context) => result);
    const wrapped = monitorHandler(original, "test-handler");
    const invocation = context(), input = { token: "private-upload-token" };
    expect(await wrapped(input, invocation)).toBe(result);
    expect(original).toHaveBeenCalledWith(input, invocation);
    expect(invocation.callbackWaitsForEmptyEventLoop).toBe(true);
    expect(events()).toHaveLength(0);
    expect(transport.initOptions.defaultIntegrations).toBe(false);
    expect(transport.initOptions.dataCollection).toMatchObject({ userInfo: false, httpHeaders: false, httpBodies: [], stackFrameVariables: false });
  });

  it("rethrows the original failure so Lambda retry behavior survives, sending only sanitized diagnostics", async () => {
    const { monitorHandler } = await import("../../amplify/functions/monitoring");
    const failure = new TypeError("private-customer@example.com private-upload-token");
    const wrapped = monitorHandler(async (_event: unknown, _context: Context) => { throw failure; }, "test-handler");
    await expect(wrapped({ token: "private-upload-token" }, context())).rejects.toBe(failure);
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({
      tags: { app: "backend", function: "test-handler" },
      exception: { values: [{ type: "TypeError", value: "Error details withheld; see application logs", mechanism: { handled: false } }] },
    });
    expect(JSON.stringify(transport.envelopes)).not.toMatch(/private-customer|private-upload-token|private-request-id|private-log-group|private-log-stream/);
  });

  it.each([
    [{ statusCode: 503, body: "private-response-body" }, "http_server_error"],
    [{ batchItemFailures: [{ itemIdentifier: "private-sequence-number" }] }, "batch_item_failure"],
    [{ handled: 2, failed: 1, error: "private-error-value" }, "worker_item_failure"],
  ])("observes returned failures without altering their retry contract: %s", async (result, kind) => {
    const { monitorHandler } = await import("../../amplify/functions/monitoring");
    const wrapped = monitorHandler(async (_event: unknown, _context: Context) => result, "worker");
    expect(await wrapped({ input: "private-input" }, context())).toBe(result);
    expect(events()).toHaveLength(1);
    expect(events()[0].tags.failure_kind).toBe(kind);
    expect(events()[0].fingerprint).toEqual(["hoa-lambda-result", "worker", kind]);
    expect(JSON.stringify(transport.envelopes)).not.toMatch(/private-/);
  });

  it("leaves expected auth/validation responses unreported", async () => {
    const { monitorHandler } = await import("../../amplify/functions/monitoring");
    for (const result of [{ statusCode: 403 }, { ok: false, error: "Validation failed" }, { failed: 0 }, { batchItemFailures: [] }]) {
      await monitorHandler(async (_event: unknown, _context: Context) => result, "resolver")({}, context());
    }
    expect(events()).toHaveLength(0);
  });

  it("flushes unexpected worker errors that are saved instead of thrown", async () => {
    const { monitorHandler, captureHandledFailure } = await import("../../amplify/functions/monitoring");
    const wrapped = monitorHandler(async (_event: unknown, _context: Context) => {
      captureHandledFailure(new Error("private-document-contents"));
      return { ok: true };
    }, "process-document");
    await wrapped({}, context());
    expect(events()).toHaveLength(1);
    expect(events()[0].tags.failure_kind).toBe("handled_job_failure");
    expect(JSON.stringify(transport.envelopes)).not.toContain("private-document-contents");
  });

  it("keeps the SDK's timeout warnings meaningful after removing free-form messages", async () => {
    const { monitorHandler } = await import("../../amplify/functions/monitoring");
    const sdk = await import("@sentry/aws-serverless");
    await monitorHandler(async (_event: unknown, _context: Context) => {
      sdk.captureMessage("Possible function timeout: private-runtime-function-name", "warning");
    }, "worker")({}, context());
    expect(events()).toHaveLength(1);
    expect(events()[0].exception.values[0].type).toBe("LambdaTimeoutWarning");
    expect(JSON.stringify(transport.envelopes)).not.toContain("private-runtime-function-name");
  });
});

describe("Lambda deployment coverage", () => {
  it("wraps every declared function entrypoint, including future additions", () => {
    const root = resolve(process.cwd(), "amplify/functions");
    const resources = readdirSync(root, { recursive: true }).filter((path) => String(path).endsWith("/resource.ts"));
    let checked = 0;
    for (const resource of resources) {
      const path = resolve(root, String(resource));
      const text = readFileSync(path, "utf8");
      const entries = [...text.matchAll(/entry:\s*["']([^"']+)["']/g)];
      expect(entries.length, `${resource}: implicit unwrapped entrypoint`).toBe([...text.matchAll(/defineFunction\s*\(/g)].length);
      for (const match of entries) {
        expect(match[1], String(resource)).toMatch(/\.sentry\.ts$/);
        expect(monitoredEntrypoint(readFileSync(resolve(dirname(path), match[1]), "utf8")), match[1]).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(40);
  });
  it('checks the exported monitored handler rather than a matching comment or unrelated wrapper', () => {
    expect(monitoredEntrypoint('export const handler = monitorHandler(batchLiveChanges(originalHandler), "worker");')).toBe(true);
    expect(monitoredEntrypoint('// monitorHandler(originalHandler,\nexport const handler = originalHandler;')).toBe(false);
    expect(monitoredEntrypoint('const monitored = monitorHandler(originalHandler, "worker"); export const handler = originalHandler;')).toBe(false);
  });

  it("configures only registered Lambda resources and keeps previews disconnected", () => {
    const fn = { resources: { lambda: {} }, addEnvironment: vi.fn() };
    const auth = { resources: { userPool: {} } };
    configureSentry({ fn, auth }, { preview: true, environment: "staging" });
    expect(fn.addEnvironment).not.toHaveBeenCalled();
    configureSentry({ fn, auth }, { preview: false, environment: "staging" });
    expect(fn.addEnvironment.mock.calls).toEqual([
      ["SENTRY_DSN", "https://public@example.com/1"], ["SENTRY_ENVIRONMENT", "test"],
      ["SENTRY_RELEASE", "test-release"], ["NODE_OPTIONS", "--enable-source-maps"],
    ]);
  });
});
