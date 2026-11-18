import type { TeamEligibility } from "../../../../shared/leadWorkflow";
import { get } from "./store";

export const AUTO_REPLIES_DISABLED_NOTE = "Automatic replies are turned off for the assigned teammate.";

/** Read before role or mailbox checks so an opted-out teammate needs no sending setup. */
export async function autoRepliesDisabled(userId: string | undefined): Promise<boolean> {
  if (!userId) return false;
  const member = await get<TeamEligibility>(`eligibility:${userId}`);
  return member?.data.autoRepliesEnabled === false;
}
