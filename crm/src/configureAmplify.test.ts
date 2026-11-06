import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { configure, listen, outputs } = vi.hoisted(() => ({
  configure: vi.fn(),
  listen: vi.fn(),
  outputs: { custom: { migration: {
    account: "917680434255", appId: "preview-app", branch: "codex-hoa-staging-migration", preview: "true",
  } } },
}));
vi.mock("aws-amplify", () => ({ Amplify: { configure } }));
vi.mock("aws-amplify/auth/enable-oauth-listener", () => ({}));
vi.mock("./lib/googleSignIn", () => ({ listenForGoogleSignInFailures: listen }));
vi.mock("../amplify_outputs.json", () => ({ default: outputs }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  outputs.custom.migration.account = "917680434255";
  outputs.custom.migration.branch = "codex-hoa-staging-migration";
});
afterEach(() => vi.unstubAllEnvs());

it("registers Google callback errors before configuring the normal CRM", async () => {
  await import("./configureAmplify");
  expect(configure).toHaveBeenCalledExactlyOnceWith(outputs);
  expect(listen.mock.invocationCallOrder[0]).toBeLessThan(configure.mock.invocationCallOrder[0]);
});

it("keeps the preview account check ahead of Google and Amplify setup", async () => {
  vi.stubEnv("VITE_HOA_MIGRATION_PREVIEW", "true");
  outputs.custom.migration.account = "637423611040";
  await expect(import("./configureAmplify")).rejects.toThrow("The migration preview must use its isolated backend configuration.");
  expect(listen).not.toHaveBeenCalled();
  expect(configure).not.toHaveBeenCalled();
});

it("preserves the isolated preview branch check", async () => {
  vi.stubEnv("VITE_HOA_MIGRATION_PREVIEW", "true");
  outputs.custom.migration.branch = "main";
  await expect(import("./configureAmplify")).rejects.toThrow("The migration preview must use its isolated backend configuration.");
  expect(configure).not.toHaveBeenCalled();
});

it("accepts the existing isolated migration preview binding", async () => {
  vi.stubEnv("VITE_HOA_MIGRATION_PREVIEW", "true");
  await import("./configureAmplify");
  expect(listen).toHaveBeenCalledOnce();
  expect(configure).toHaveBeenCalledExactlyOnceWith(outputs);
});
