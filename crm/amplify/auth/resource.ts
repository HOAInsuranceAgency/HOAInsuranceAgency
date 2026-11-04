import { defineAuth, secret } from "@aws-amplify/backend";
import { googleSignIn } from "../functions/google-sign-in/resource";
import { destinationStagingNativeAuth, googleRedirectUrls, googleSignInEnabled } from "./config";
import {
  magicLinkDefine,
  magicLinkCreate,
  magicLinkVerify,
  migrationNativeMessage,
} from "../functions/magic-link/resource";

/**
 * CRM auth: passwordless email links plus optional Google sign-in. No
 * self-signup: Google identities are linked only to existing invited users.
 *
 * Cognito groups are the authority for CRM roles; OWNER includes admin access.
 */
export const auth = defineAuth({
  loginWith: {
    email: true,
    ...(googleSignInEnabled ? {
      externalProviders: {
        google: {
          clientId: secret("GOOGLE_CLIENT_ID"),
          clientSecret: secret("GOOGLE_CLIENT_SECRET"),
          scopes: ["openid", "email", "profile"],
          attributeMapping: {
            email: "email",
            emailVerified: "email_verified",
            custom: { "custom:googleHostedDomain": "hd" },
          },
        },
        scopes: ["OPENID", "EMAIL", "PROFILE"],
        callbackUrls: googleRedirectUrls,
        logoutUrls: googleRedirectUrls,
      },
    } : {}),
  },
  // Cognito custom attributes cannot be removed after creation. Keep this
  // optional schema attribute stable even when Google is switched off.
  ...(destinationStagingNativeAuth ? {} : { userAttributes: {
    "custom:googleHostedDomain": { dataType: "String", mutable: true },
  } }),
  groups: ["OWNER", "ADMIN", "STAFF", "PRODUCER"],
  triggers: {
    ...(destinationStagingNativeAuth ? {} : { preSignUp: googleSignIn }),
    defineAuthChallenge: magicLinkDefine,
    createAuthChallenge: magicLinkCreate,
    verifyAuthChallengeResponse: magicLinkVerify,
    ...(process.env.HOA_MIGRATION_PREVIEW === "true" ? { customMessage: migrationNativeMessage } : {}),
  },
});
