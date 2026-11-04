import type { TeamEligibility } from "../../../../shared/leadWorkflow";
import { receivesNewLeads, salespersonEligibility } from "../../../../shared/salespersonOwnership";
import { dataClient } from "./data";
import { team } from "./workflow";

type DisplayProfile = { userId: string; firstName?: string | null; lastName?: string | null; email: string };

/** Names and materialized eligibility are display hints, never permission checks.
 * Assignment/settings writes still verify the selected user's current Cognito
 * membership, persistent access status and transaction-time availability.
 * Do not call this helper from an authorization or delivery decision. */
export async function displayRoster(): Promise<TeamEligibility[]> {
  const profilesRequest = (async () => {
    const client = await dataClient(), profiles: DisplayProfile[] = [], seen = new Set<string>();
    let nextToken: string | undefined;
    do {
      const page = await client.models.UserProfile.list({ nextToken, limit: 100,
        selectionSet: ["userId", "firstName", "lastName", "email"] });
      if (page.errors?.length) throw new Error("Could not load teammates");
      profiles.push(...page.data);
      nextToken = page.nextToken ?? undefined;
      if (nextToken && seen.has(nextToken)) throw new Error("Could not finish loading teammates");
      if (nextToken) seen.add(nextToken);
    } while (nextToken);
    return profiles;
  })();
  const [profiles, eligibility] = await Promise.all([profilesRequest, team()]);
  const savedById = new Map(eligibility.map(member => [member.userId, salespersonEligibility(member)]));
  return profiles.map(profile => {
    const saved = savedById.get(profile.userId), producer = saved?.salesperson === true;
    // Missing snapshots stay in the directory, but cannot become assignment
    // candidates merely because an editable profile says "PRODUCER".
    const enabled = saved?.enabled === true;
    return { ...saved, userId: profile.userId,
      name: `${profile.firstName ?? ""} ${profile.lastName ?? ""}`.trim() || profile.email,
      email: profile.email, version: saved?.version ?? 0,
      enabled, available: enabled, salesperson: producer,
      receiveNewLeads: receivesNewLeads(saved, producer) };
  });
}
