import { defineAuth } from "@aws-amplify/backend";

/**
 * CRM auth: email sign-in, invite-only in practice (create users from the
 * Cognito console or an admin flow — self-signup is for staff/producers
 * onboarding themselves after being invited).
 *
 * Groups are role placeholders; privileges are not enforced yet.
 */
export const auth = defineAuth({
  loginWith: {
    email: true,
  },
  groups: ["ADMIN", "STAFF", "PRODUCER"],
});
