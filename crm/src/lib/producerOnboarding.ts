import { client, listAllPages, type License } from "./client";

export type SavedProducerLicense = Pick<License, "id" | "state" | "licenseNumber">;

/** Only a persisted state license for this producer satisfies onboarding. */
export async function loadProducerLicenses(profileId: string): Promise<SavedProducerLicense[]> {
  const [current, legacy] = await Promise.all([
    listAllPages(async (nextToken) => {
      const result = await client.models.License.list({
        filter: { userProfileId: { eq: profileId }, holderType: { eq: "PRODUCER" } },
        nextToken,
      });
      if (result.errors?.length) {
        throw new Error(result.errors[0].message || "Couldn't load your producer licenses.");
      }
      return result;
    }),
    // Older onboarding saved ProducerLicense rows. Count these until they
    // have been migrated so existing licensed users need not re-enter them.
    listAllPages(async (nextToken) => {
      const result = await client.models.ProducerLicense.list({
        filter: { userProfileId: { eq: profileId } }, nextToken,
      });
      if (result.errors?.length) {
        throw new Error(result.errors[0].message || "Couldn't load your producer licenses.");
      }
      return result;
    }),
  ]);
  const licenses = [
    ...current.filter((license) => license.userProfileId === profileId && license.holderType === "PRODUCER"),
    ...legacy.filter((license) => license.userProfileId === profileId),
  ].filter((license) => license.state.trim() && license.licenseNumber.trim());
  return licenses.filter((license, i) => licenses.findIndex((candidate) =>
    candidate.state === license.state && candidate.licenseNumber === license.licenseNumber
  ) === i);
}
