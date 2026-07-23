import { defineAuth } from "@aws-amplify/backend";
import {
  magicLinkDefine,
  magicLinkCreate,
  magicLinkVerify,
} from "../functions/magic-link/resource";

/**
 * CRM auth: passwordless magic-link sign-in ONLY (custom auth challenge —
 * see functions/magic-link). No passwords, no self-signup: users are
 * invite-only, created by an admin (Cognito console/CLI), then sign in by
 * clicking the link emailed to them.
 *
 * Groups are role placeholders; privileges are not enforced yet.
 */
export const auth = defineAuth({
  loginWith: {
    email: true,
  },
  groups: ["ADMIN", "STAFF", "PRODUCER"],
  triggers: {
    defineAuthChallenge: magicLinkDefine,
    createAuthChallenge: magicLinkCreate,
    verifyAuthChallengeResponse: magicLinkVerify,
  },
});
