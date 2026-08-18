import { defineFunction } from "@aws-amplify/backend";

/**
 * The document-request portal a lead reaches from their auto-reply email.
 *
 * Backs two API-key fields, `getUploadPortal` and `requestPortalUpload`, both
 * gated entirely on the link's token. Like `lead-upload` it presigns with its
 * own credentials rather than opening `documents/` to unauthenticated writes,
 * and lands objects at the same key layout a staff upload uses so OCR and the
 * Documents tab need no special case.
 *
 * ── Why this is not `lead-upload` ────────────────────────────────────────────
 * It very nearly was. `lead-upload/dispatch.ts` tells the difference between its
 * two fields by sniffing their arguments, because Amplify's resolver sends no
 * `event.info`, and it says outright: give a third operation an argument no
 * other one has, or an explicit `op`, "rather than making this cleverer". A
 * third and fourth field whose arguments overlap `requestLeadUpload`'s almost
 * exactly is precisely the case that warning is about.
 *
 * They also guard different things. `lead-upload` resolves a token to a *reply
 * window* and every path extends a deadline; this resolves a token to a portal
 * that has no deadline and must keep working for weeks. Sharing a function would
 * mean every guard checking which kind of token it had.
 *
 * The presigning both do is genuinely duplicated, and deliberately: it is
 * fifteen lines of SDK call, and the alternative — a shared module reaching
 * across two function bundles — buys less than it costs.
 *
 * Not scheduled; invoked by AppSync. The 30s timeout covers one paged Document
 * list plus a presign.
 */
export const uploadPortal = defineFunction({
  name: "upload-portal",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  memoryMB: 512,
  resourceGroupName: "data",
});
