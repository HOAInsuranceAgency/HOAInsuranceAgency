import { defineFunction } from "@aws-amplify/backend";

/**
 * Cognito custom-auth-challenge triggers implementing passwordless
 * magic-link sign-in (see shared token logic in ./token.ts):
 *
 *  1. User enters email → app starts CUSTOM_WITHOUT_SRP sign-in with
 *     clientMetadata.mode="request" → createAuthChallenge emails a link
 *     containing an HMAC-signed, 15-minute token.
 *  2. Clicking the link opens the portal, which starts a fresh sign-in with
 *     mode="consume" (no email sent) and answers the challenge with the
 *     token → verifyAuthChallengeResponse checks signature/expiry/email.
 */
// resourceGroupName "auth": auth triggers must live in the auth stack, or
// the auth↔function stacks become circularly dependent.
export const magicLinkDefine = defineFunction({
  name: "magic-link-define",
  entry: "./define.ts",
  resourceGroupName: "auth",
});

export const magicLinkCreate = defineFunction({
  name: "magic-link-create",
  entry: "./create.ts",
  resourceGroupName: "auth",
});

export const magicLinkVerify = defineFunction({
  name: "magic-link-verify",
  entry: "./verify.ts",
  resourceGroupName: "auth",
});
