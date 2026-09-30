import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const profileWrites = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn() }));
const createLicense = vi.hoisted(() => vi.fn());
vi.mock("../lib/client", () => ({
  client: { models: { UserProfile: profileWrites, License: { create: createLicense } } },
  US_STATES: ["FL", "NY"],
  friendlyError: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));

import Onboarding from "./Onboarding";
import type { UserProfile } from "../lib/client";

const existing = {
  id: "profile-one",
  userId: "user-one",
  email: "alex@example.com",
  firstName: "Alex",
  lastName: "Agent",
  role: "ADMIN",
  onboardingComplete: false,
} as UserProfile;
const user = { userId: "user-one", username: "alex@example.com" };

function field(label: string) {
  return screen.getByText(label, { selector: "label" }).parentElement!
    .querySelector<HTMLInputElement | HTMLSelectElement>("input, select")!;
}

beforeEach(() => {
  vi.clearAllMocks();
  profileWrites.update.mockResolvedValue({ data: { ...existing, onboardingComplete: true } });
  createLicense.mockResolvedValue({ data: { id: "license-one" } });
});

describe("onboarding assigned roles", () => {
  it("requires and saves producer details even when ADMIN is the primary assigned role", async () => {
    const onComplete = vi.fn();
    render(<Onboarding user={user} existing={existing} role="ADMIN" roles={["ADMIN", "PRODUCER"]} onComplete={onComplete} />);

    expect(field("Assigned roles")).toHaveValue("Admin + Producer");
    expect(field("Assigned roles")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Complete setup" }));
    expect(screen.getByText("Producers must provide their NPN.")).toBeInTheDocument();
    expect(profileWrites.update).not.toHaveBeenCalled();

    fireEvent.change(field("NPN (National Producer Number) *"), { target: { value: "12345678" } });
    fireEvent.click(screen.getByRole("button", { name: "Complete setup" }));
    expect(screen.getByText("Producers must provide at least one state license.")).toBeInTheDocument();
    expect(profileWrites.update).not.toHaveBeenCalled();

    fireEvent.change(field("State"), { target: { value: "FL" } });
    fireEvent.change(field("License number"), { target: { value: "P123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Complete setup" }));

    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(profileWrites.update).toHaveBeenCalledWith(expect.objectContaining({
      id: "profile-one", role: "ADMIN", npn: "12345678", onboardingComplete: true,
    }));
    expect(createLicense).toHaveBeenCalledWith(expect.objectContaining({
      userProfileId: "profile-one", holderType: "PRODUCER", holderName: "Alex Agent",
      state: "FL", licenseNumber: "P123456", npn: "12345678",
    }));
  });

  it("does not require producer details for an admin without the producer role", async () => {
    const onComplete = vi.fn();
    render(<Onboarding user={user} existing={existing} role="ADMIN" roles={["ADMIN"]} onComplete={onComplete} />);

    expect(screen.queryByText("NPN (National Producer Number) *")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "State licenses *" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Complete setup" }));

    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(createLicense).not.toHaveBeenCalled();
    expect(profileWrites.update).toHaveBeenCalledWith(expect.objectContaining({ role: "ADMIN" }));
  });
});
