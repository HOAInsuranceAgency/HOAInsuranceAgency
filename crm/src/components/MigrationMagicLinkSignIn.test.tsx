import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const signIn = vi.hoisted(() => vi.fn());
const confirmSignIn = vi.hoisted(() => vi.fn());
vi.mock("aws-amplify/auth", () => ({ signIn, confirmSignIn }));
import MagicLinkSignIn from "./MagicLinkSignIn";
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
function preview(enabled: boolean) {
  vi.stubEnv("VITE_HOA_MIGRATION_AUTH", "true"); vi.stubEnv("VITE_HOA_MIGRATION_PREVIEW", "true");
  vi.stubEnv("VITE_HOA_PREVIEW_ADMIN_LOGIN", enabled ? "true" : "false");
  vi.stubEnv("VITE_HOA_PREVIEW_ADMIN_LOGIN_EXPIRES_AT", "2099-01-01T00:00:00Z");
}
it("hides sign-in and performs no auth call while preview login is off", () => {
  preview(false); render(<MagicLinkSignIn />);
  expect(screen.getByText(/Administrator sign-in and email are disabled/)).toBeInTheDocument();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument(); expect(signIn).not.toHaveBeenCalled();
});
it("uses one explicit REQUEST_LINK answer after creating the no-mail challenge", async () => {
  preview(true); signIn.mockResolvedValue({ nextStep: { signInStep: "CONFIRM_SIGN_IN_WITH_CUSTOM_CHALLENGE" } });
  confirmSignIn.mockResolvedValue({ isSignedIn: false }); render(<MagicLinkSignIn />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "jake@getgim.com" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Email me a sign-in link" })); });
  expect(signIn).toHaveBeenCalledTimes(1); expect(confirmSignIn).toHaveBeenCalledExactlyOnceWith({ challengeResponse: "REQUEST_LINK" });
});
it("refuses an expired administrator preview before requesting an email", () => {
  preview(true); vi.stubEnv("VITE_HOA_PREVIEW_ADMIN_LOGIN_EXPIRES_AT", "2020-01-01"); render(<MagicLinkSignIn />);
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument(); expect(signIn).not.toHaveBeenCalled();
});
