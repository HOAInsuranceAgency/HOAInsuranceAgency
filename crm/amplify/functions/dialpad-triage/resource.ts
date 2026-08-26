import { defineFunction } from "@aws-amplify/backend";

/**
 * The triage queue's four buttons.
 *
 * A Lambda rather than client-side model writes because filing one call is
 * several writes that have to land together: the Communication row moves off
 * the queue, its appearance rows appear, and a PhoneLink may be created so
 * the next call from that number never reaches the queue at all. Split across
 * the client, a half-applied filing leaves the queue and the timelines
 * disagreeing about where a call went — and `Communication` is read-only to a
 * signed-in user precisely so that cannot happen.
 *
 * Invoked by a person, so unlike the other two Dialpad functions it is
 * synchronous and its result is a screen's next state.
 */
export const dialpadTriage = defineFunction({
  name: "dialpad-triage",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  memoryMB: 512,
  resourceGroupName: "data",
});
