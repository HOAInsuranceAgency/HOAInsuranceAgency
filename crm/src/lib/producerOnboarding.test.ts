import { beforeEach, describe, expect, it, vi } from "vitest";

const indexedLicenses = vi.hoisted(() => vi.fn());
const scanLicenses = vi.hoisted(() => vi.fn());
const scanLegacyLicenses = vi.hoisted(() => vi.fn());
vi.mock("./client", async () => ({
  client: { models: {
    License: { listLicenseByUserProfileId: indexedLicenses, list: scanLicenses },
    ProducerLicense: { list: scanLegacyLicenses },
  } },
  listAllPages: (await import("./pagination")).listAllPages,
}));

import { loadProducerLicenses } from "./producerOnboarding";

const license = {
  id: "license-one", userProfileId: "profile-one", holderType: "PRODUCER",
  state: "FL", licenseNumber: "FL123456",
};

beforeEach(() => {
  vi.resetAllMocks();
  indexedLicenses.mockResolvedValue({ data: [license] });
  scanLicenses.mockRejectedValue(new Error("License table scans are not allowed"));
  scanLegacyLicenses.mockRejectedValue(new Error("Legacy licensing reads are not allowed"));
});

describe("producer onboarding license lookup", () => {
  it("pages through the producer's index, including empty pages, without scanning either model", async () => {
    indexedLicenses.mockResolvedValueOnce({ data: [], nextToken: "next-page" })
      .mockResolvedValueOnce({ data: [license], nextToken: null });

    await expect(loadProducerLicenses("profile-one")).resolves.toEqual([license]);
    expect(indexedLicenses).toHaveBeenNthCalledWith(1,
      { userProfileId: "profile-one" },
      { filter: { holderType: { eq: "PRODUCER" } }, nextToken: undefined },
    );
    expect(indexedLicenses).toHaveBeenNthCalledWith(2,
      { userProfileId: "profile-one" },
      { filter: { holderType: { eq: "PRODUCER" } }, nextToken: "next-page" },
    );
    expect(indexedLicenses).toHaveBeenCalledTimes(2);
    expect(scanLicenses).not.toHaveBeenCalled();
    expect(scanLegacyLicenses).not.toHaveBeenCalled();
  });

  it("keeps only complete producer licenses for the requested profile and deduplicates across pages", async () => {
    const nyLicense = { ...license, id: "license-ny", state: "NY" };
    indexedLicenses.mockResolvedValueOnce({ data: [
      license,
      { ...license, id: "firm-license", holderType: "FIRM" },
      { ...license, id: "other-producer", userProfileId: "another-profile" },
      { ...license, id: "no-state", state: " " },
      { ...license, id: "no-number", licenseNumber: " " },
    ], nextToken: "next-page" }).mockResolvedValueOnce({ data: [
      { ...license, id: "duplicate-license" }, nyLicense,
    ] });

    await expect(loadProducerLicenses("profile-one")).resolves.toEqual([license, nyLicense]);
  });

  it("rejects a later page with GraphQL errors instead of returning earlier rows as sufficient proof", async () => {
    indexedLicenses.mockResolvedValueOnce({ data: [license], nextToken: "next-page" })
      .mockResolvedValueOnce({ data: [], errors: [{ message: "License lookup denied" }] });

    await expect(loadProducerLicenses("profile-one")).rejects.toThrow("License lookup denied");
  });

  it("reports a useful fallback for a GraphQL error without a message", async () => {
    indexedLicenses.mockResolvedValueOnce({ data: [], errors: [{}] });

    await expect(loadProducerLicenses("profile-one")).rejects.toThrow("Couldn't load your producer licenses.");
  });

  it("propagates an unavailable index instead of treating the producer as unlicensed", async () => {
    indexedLicenses.mockRejectedValueOnce(new Error("Network unavailable"));

    await expect(loadProducerLicenses("profile-one")).rejects.toThrow("Network unavailable");
  });
});
