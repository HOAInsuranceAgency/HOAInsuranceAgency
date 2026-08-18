/**
 * Which of the two mutations an invocation is.
 *
 * ## Why this is not just `event.info.fieldName`
 *
 * Amplify Gen 2 resolves a custom mutation through a generated JS resolver that
 * invokes the Lambda with a payload of `{ arguments, identity, source, request,
 * prev }`. There is no `info`, so `event.info?.fieldName` is always undefined
 * and a switch on it falls straight through to the default. `team-admin` found
 * this first and does the same thing: prefer `info` if a future runtime supplies
 * it, otherwise tell the operations apart by their arguments.
 *
 * The two are distinguishable because `requestLeadUpload` needs a filename and
 * `closeLeadUploadWindow` takes nothing but the token. If a third operation
 * ever lands on this function, give it an argument no other one has — or an
 * explicit `op` argument — rather than making this cleverer.
 *
 * Pure and dependency-free so the dispatch is unit tested. It reached
 * production once returning "Unknown operation." for every call, and nothing
 * but a live probe caught it.
 */

export type LeadUploadOperation = "requestLeadUpload" | "closeLeadUploadWindow";

export interface DispatchableEvent {
  info?: { fieldName?: string };
  arguments?: Record<string, unknown>;
}

export function operationOf(event: DispatchableEvent): LeadUploadOperation | null {
  const named = event.info?.fieldName;
  if (named === "requestLeadUpload" || named === "closeLeadUploadWindow") {
    return named;
  }

  const args = event.arguments ?? {};
  // A token alone cannot be a request for somewhere to put a file.
  if (typeof args.filename === "string") return "requestLeadUpload";
  if (typeof args.uploadToken === "string") return "closeLeadUploadWindow";
  return null;
}
