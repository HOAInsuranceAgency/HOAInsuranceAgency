import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const profileWrites = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn(), get: vi.fn() }));
const licenseModels = vi.hoisted(() => ({ create: vi.fn(), listLicenseByUserProfileId: vi.fn() }));
vi.mock("../lib/client", async () => ({
  client: { models: { UserProfile: profileWrites, License: licenseModels } },
  listAllPages: (await import("../lib/pagination")).listAllPages,
  US_STATES: ["FL", "NY"],
  friendlyError: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));

import Onboarding from "./Onboarding";
import type { License, UserProfile } from "../lib/client";

const existing = {
  id: "profile-one", userId: "user-one", email: "alex@example.com",
  firstName: "Alex", lastName: "Agent", role: "ADMIN", onboardingComplete: false,
} as UserProfile;
const user = { userId: "user-one", username: "alex@example.com" };
const savedLicense = {
  id: "license-one", userProfileId: "profile-one", holderType: "PRODUCER", state: "FL", licenseNumber: "P123456",
} as License;
let persisted: License[];
let storedProfile: UserProfile;

function field(label: string, index = 0) {
  return screen.getAllByText(label, { selector: "label" })[index].parentElement!
    .querySelector<HTMLInputElement | HTMLSelectElement>("input, select")!;
}
function enterProducerDetails() {
  fireEvent.change(field("NPN (National Producer Number) *"), { target: { value: "12345678" } });
  fireEvent.change(field("State"), { target: { value: "FL" } });
  fireEvent.change(field("License number"), { target: { value: "P123456" } });
}
const submit = () => fireEvent.click(screen.getByRole("button", { name: "Complete setup" }));

beforeEach(() => {
  vi.resetAllMocks();
  persisted = [];
  storedProfile = { ...existing };
  profileWrites.get.mockImplementation(async ({ id }) => ({ data: storedProfile.id === id ? storedProfile : null }));
  profileWrites.update.mockImplementation(async (payload) => {
    storedProfile = { ...storedProfile, ...payload };
    return { data: storedProfile };
  });
  profileWrites.create.mockImplementation(async (payload) => {
    storedProfile = { ...existing, ...payload };
    return { data: storedProfile };
  });
  licenseModels.listLicenseByUserProfileId.mockImplementation(async () => ({ data: [...persisted] }));
  licenseModels.create.mockImplementation(async (payload) => {
    persisted.push(payload);
    return { data: payload };
  });
});

describe("onboarding assigned roles", () => {
  it("requires and saves producer details even when ADMIN is the primary assigned role", async () => {
    const onComplete = vi.fn();
    render(<Onboarding user={user} existing={existing} role="ADMIN" roles={["ADMIN", "PRODUCER"]} onComplete={onComplete} />);
    expect(field("Assigned roles")).toHaveValue("Admin + Producer");
    expect(field("Assigned roles")).toBeDisabled();
    submit();
    expect(screen.getByText("Producers must provide their NPN.")).toBeInTheDocument();
    expect(profileWrites.update).not.toHaveBeenCalled();
    fireEvent.change(field("NPN (National Producer Number) *"), { target: { value: "12345678" } });
    submit();
    expect(screen.getByText("Producers must provide at least one state license.")).toBeInTheDocument();
    expect(profileWrites.update).not.toHaveBeenCalled();
    enterProducerDetails();
    submit();

    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(profileWrites.update).toHaveBeenNthCalledWith(1, expect.objectContaining({
      id: "profile-one", role: "ADMIN", npn: "12345678", onboardingComplete: false,
    }));
    expect(licenseModels.create).toHaveBeenCalledWith(expect.objectContaining({
      userProfileId: "profile-one", holderType: "PRODUCER", holderName: "Alex Agent",
      state: "FL", licenseNumber: "P123456", npn: "12345678",
    }));
    expect(profileWrites.update).toHaveBeenLastCalledWith({ id: "profile-one", onboardingComplete: true });
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ onboardingComplete: true }), persisted);
  });

  it("does not require producer details for an admin without the producer role", async () => {
    const onComplete = vi.fn();
    render(<Onboarding user={user} existing={existing} role="ADMIN" roles={["ADMIN"]} onComplete={onComplete} />);
    expect(screen.queryByText("NPN (National Producer Number) *")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "State licenses *" })).not.toBeInTheDocument();
    submit();
    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(licenseModels.create).not.toHaveBeenCalled();
    expect(profileWrites.update).toHaveBeenCalledWith(expect.objectContaining({ role: "ADMIN", onboardingComplete: true }));
  });

  it("reuses a saved license when a promoted producer only needs to enter their NPN", async () => {
    persisted = [savedLicense];
    const onComplete = vi.fn();
    render(<Onboarding user={user} existing={{ ...existing, onboardingComplete: true }} existingLicenses={persisted}
      role="ADMIN" roles={["ADMIN", "PRODUCER"]} onComplete={onComplete} />);
    expect(screen.getByText("Saved license: FL · P123456")).toBeInTheDocument();
    expect(screen.queryByText("License number", { selector: "label" })).not.toBeInTheDocument();
    fireEvent.change(field("NPN (National Producer Number) *"), { target: { value: "12345678" } });
    submit();

    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(licenseModels.create).not.toHaveBeenCalled();
    expect(storedProfile.onboardingComplete).toBe(true);
  });

  it("preserves an existing NPN but requires a saved state license", async () => {
    const onComplete = vi.fn();
    render(<Onboarding user={user} existing={{ ...existing, npn: "12345678", onboardingComplete: true }}
      role="STAFF" roles={["STAFF", "PRODUCER"]} onComplete={onComplete} />);
    expect(field("NPN (National Producer Number) *")).toHaveValue("12345678");
    submit();
    expect(screen.getByText("Producers must provide at least one state license.")).toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("does not complete onboarding on a license GraphQL error and retries without duplicating partial saves", async () => {
    const onComplete = vi.fn();
    licenseModels.create.mockImplementationOnce(async (payload) => {
      persisted.push(payload);
      return { data: payload };
    }).mockResolvedValueOnce({ data: null, errors: [{ message: "Could not save NY license" }] });
    render(<Onboarding user={user} existing={{ ...existing, onboardingComplete: true }} role="ADMIN"
      roles={["ADMIN", "PRODUCER"]} onComplete={onComplete} />);
    enterProducerDetails();
    fireEvent.click(screen.getByRole("button", { name: "+ Add another license" }));
    fireEvent.change(field("State", 1), { target: { value: "NY" } });
    fireEvent.change(field("License number", 1), { target: { value: "NY123" } });
    submit();
    expect(await screen.findByText("Could not save NY license")).toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();
    expect(storedProfile.onboardingComplete).toBe(false);
    expect(persisted).toHaveLength(1);
    expect(field("License number")).toHaveValue("NY123");
    submit();

    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(licenseModels.create.mock.calls.map(([input]) => input.state)).toEqual(["FL", "NY", "NY"]);
    expect(persisted).toHaveLength(2);
    expect(storedProfile.onboardingComplete).toBe(true);
  });

  it("recovers a license whose write succeeded but whose response was lost", async () => {
    const onComplete = vi.fn();
    licenseModels.create.mockImplementationOnce(async (payload) => {
      persisted.push(payload);
      throw new Error("Connection lost");
    });
    render(<Onboarding user={user} existing={existing} role="PRODUCER" onComplete={onComplete} />);
    enterProducerDetails();
    submit();
    expect(await screen.findByText("Connection lost")).toBeInTheDocument();
    expect(storedProfile.onboardingComplete).toBe(false);
    submit();

    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(licenseModels.create).toHaveBeenCalledOnce();
    expect(persisted).toHaveLength(1);
  });

  it("retains a newly created profile and saved licenses when completion fails and license lists lag", async () => {
    const onComplete = vi.fn();
    profileWrites.update.mockResolvedValueOnce({ data: null, errors: [{ message: "Could not finish setup" }] });
    // The new row has not reached the eventually consistent list yet.
    licenseModels.listLicenseByUserProfileId.mockResolvedValue({ data: [] });
    render(<Onboarding user={user} existing={null} role="PRODUCER" onComplete={onComplete} />);
    fireEvent.change(field("First name *"), { target: { value: "Alex" } });
    fireEvent.change(field("Last name *"), { target: { value: "Agent" } });
    enterProducerDetails();
    submit();
    expect(await screen.findByText("Could not finish setup")).toBeInTheDocument();
    expect(storedProfile.onboardingComplete).toBe(false);
    expect(onComplete).not.toHaveBeenCalled();
    submit();

    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(profileWrites.create).toHaveBeenCalledOnce();
    expect(licenseModels.create).toHaveBeenCalledOnce();
    expect(storedProfile.onboardingComplete).toBe(true);
  });

  it("recovers a newly created profile whose response was lost without creating a duplicate", async () => {
    const onComplete = vi.fn();
    profileWrites.create.mockImplementationOnce(async (payload) => {
      storedProfile = { ...existing, ...payload };
      throw new Error("Profile response lost");
    });
    render(<Onboarding user={user} existing={null} role="PRODUCER" onComplete={onComplete} />);
    fireEvent.change(field("First name *"), { target: { value: "Alex" } });
    fireEvent.change(field("Last name *"), { target: { value: "Agent" } });
    enterProducerDetails();
    submit();

    expect(await screen.findByText("Profile response lost")).toBeInTheDocument();
    expect(storedProfile.id).toBe("onboarding:user-one");
    expect(storedProfile.onboardingComplete).toBe(false);
    expect(onComplete).not.toHaveBeenCalled();
    submit();

    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(profileWrites.create).toHaveBeenCalledOnce();
    expect(profileWrites.get).toHaveBeenLastCalledWith({ id: "onboarding:user-one" });
    expect(licenseModels.create).toHaveBeenCalledWith(expect.objectContaining({ userProfileId: "onboarding:user-one" }));
    expect(storedProfile.onboardingComplete).toBe(true);
  });

  it("keeps onboarding incomplete if existing license verification fails", async () => {
    const onComplete = vi.fn();
    licenseModels.listLicenseByUserProfileId.mockResolvedValueOnce({ data: [], errors: [{ message: "License read failed" }] });
    render(<Onboarding user={user} existing={{ ...existing, onboardingComplete: true, npn: "12345678" }}
      existingLicenses={[savedLicense]} role="PRODUCER" onComplete={onComplete} />);
    submit();
    expect(await screen.findByText("License read failed")).toBeInTheDocument();
    expect(storedProfile.onboardingComplete).toBe(false);
    expect(licenseModels.create).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });
});
