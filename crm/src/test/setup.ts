// Vitest setup, loaded once per test file (see `test.setupFiles` in vite.config.ts).
//
// - Registers the jest-dom matchers (toBeInTheDocument, toHaveTextContent, ...)
//   on Vitest's `expect`, including their TypeScript augmentation.
// - Unmounts anything React Testing Library rendered, so tests stay isolated.
//   We do this explicitly because `globals` is off, and RTL's automatic cleanup
//   only registers itself when a global `afterEach` exists.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// Tests that exercise business handlers can set retained deployment namespaces.
// Never let their best-effort notifications contact a real AppSync endpoint.
// The publisher contract tests explicitly unmock this boundary and stub fetch.
vi.mock("../../amplify/functions/live-changes", () => ({
  publishLiveChange: vi.fn(async () => {}),
  publishCrmChange: vi.fn(async () => {}),
  publishOwnerChange: vi.fn(async () => {}),
  publishPersonalChange: vi.fn(async () => {}),
}));

afterEach(() => {
  cleanup();
});
