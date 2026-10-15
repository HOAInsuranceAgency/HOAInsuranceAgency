import { enabledUser, hasProducerRole, UnavailableTeammateError } from "./workflow";

const CONCURRENCY = 4;

/** Resolve only roster identities, independent of the size of the user pool. */
export async function availableTeamUsers(
  userIds: string[],
): Promise<Set<string>> {
  const ids = [...new Set(userIds)],
    available = new Set<string>();
  for (let offset = 0; offset < ids.length; offset += CONCURRENCY) {
    // Settle the whole batch before propagating an outage, so a retry cannot
    // overlap requests abandoned by an early Promise.all rejection.
    const results = await Promise.allSettled(
      ids.slice(offset, offset + CONCURRENCY).map(async (id) => {
        try {
          await enabledUser(id);
          available.add(id);
        } catch (error) {
          if (!(error instanceof UnavailableTeammateError)) throw error;
        }
      }),
    );
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
  }
  return available;
}

/** Read current roles together with sign-in availability; storage is only preferences. */
export async function currentTeamRoles(userIds: string[]): Promise<{ available: Set<string>; producers: Set<string> }> {
  const ids = [...new Set(userIds)], available = new Set<string>(), producers = new Set<string>();
  for (let offset = 0; offset < ids.length; offset += CONCURRENCY) {
    const results = await Promise.allSettled(ids.slice(offset, offset + CONCURRENCY).map(async id => {
      try {
        const user = await enabledUser(id);
        available.add(id);
        if (await hasProducerRole(id, user)) producers.add(id);
      } catch (error) { if (!(error instanceof UnavailableTeammateError)) throw error; }
    }));
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
  return { available, producers };
}
