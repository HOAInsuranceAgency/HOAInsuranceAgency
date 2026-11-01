import { afterEach, describe, expect, it, vi } from "vitest";
import { assertPreviewRead } from "../../amplify/functions/migration-readonly";

afterEach(() => vi.unstubAllEnvs());
describe("migration preview business execution", () => {
  it("denies writes and external-provider reads before they execute", () => {
    vi.stubEnv("HOA_MIGRATION_PREVIEW", "true");
    expect(() => assertPreviewRead(false)).toThrow("disabled");
    expect(() => assertPreviewRead(true)).not.toThrow();
  });
  it("preserves release behavior", () => {
    vi.stubEnv("HOA_MIGRATION_PREVIEW", "false");
    expect(() => assertPreviewRead(false)).not.toThrow();
  });
});
