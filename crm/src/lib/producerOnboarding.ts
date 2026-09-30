import { client, listAllPages, type License } from "./client";

export type SavedProducerLicense = Pick<License, "id" | "state" | "licenseNumber">;

/** Only a persisted state license for this producer satisfies onboarding. */
export async function loadProducerLicenses(profileId: string): Promise<SavedProducerLicense[]> {
  const rows = await listAllPages(async (nextToken) => {
    const result = await client.models.License.listLicenseByUserProfileId(
      { userProfileId: profileId },
      { filter: { holderType: { eq: "PRODUCER" } }, nextToken },
    );
    if (result.errors?.length) {
      throw new Error(result.errors[0].message || "Couldn't load your producer licenses.");
    }
    return result;
  });
  const seen = new Set<string>();
  return rows.filter((license) => {
    if (license.userProfileId !== profileId || license.holderType !== "PRODUCER" ||
      !license.state.trim() || !license.licenseNumber.trim()) return false;
    const key = JSON.stringify([license.state, license.licenseNumber]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
