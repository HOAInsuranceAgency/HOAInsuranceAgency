# Google sign-in

The CRM supports **Continue with Google** alongside its existing passwordless
email links. Google sign-in is optional and stays hidden until the deployed
backend is configured. It uses Cognito's authorization-code redirect flow;
Google client credentials stay in Amplify backend secrets.

## Account access

An administrator must first invite the exact Google email address in
**Settings → Team**. The first Google sign-in links the Google identity to that
existing Cognito account, keeping its user ID, assigned roles, profile, account
assignments, and records. It does not create a new team member or assign roles.
Unknown, disabled, unverified, or roleless accounts are rejected.

Automatic linking accepts Gmail accounts and Google Workspace accounts whose
Google `hd` claim matches their email domain. A Google account registered with
another email provider must use the email-link option. Google warns that
`email_verified` alone does not establish continued ownership of third-party
email addresses; see [Google's authoritative-email guidance](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).

The embedded Front sidebar continues to use its email-link flow. Google sign-in
is available in the standalone CRM, since OAuth redirects cannot complete
inside that embedded panel.

## Configure staging first

1. In the agency's [Google Cloud console](https://console.cloud.google.com/apis/credentials),
   create an OAuth client with application type **Web application**. Configure
   the application's consent screen and audience, including test users if the
   consent screen is still in testing. A Google Maps/Places API key is a
   different credential and cannot be reused here.
2. In the **CRM Amplify app**, save backend secrets named `GOOGLE_CLIENT_ID`
   and `GOOGLE_CLIENT_SECRET` for the staging branch. Use Amplify's secret
   management, rather than a `VITE_` variable, a checked-in file, or a frontend
   environment variable.
3. Set the staging branch's build environment variable
   `GOOGLE_SIGN_IN_ENABLED=true` and deploy the reviewed change to staging.
   Without that exact value, Google remains disabled and no Google secrets are
   required to build or deploy.
4. From the generated `crm/amplify_outputs.json`, read `auth.oauth.domain`.
   In the Google OAuth client, add:

   | Google setting | Value |
   | --- | --- |
   | Authorized JavaScript origin | `https://<auth.oauth.domain>` |
   | Authorized redirect URI | `https://<auth.oauth.domain>/oauth2/idpresponse` |

   This redirect URI belongs to Cognito. The CRM's own callback URL is a
   separate setting maintained in `crm/amplify/auth/config.ts`.
5. Verify the live staging flow below. Repeat the secret, environment-variable,
   and Google-client settings for production when promoting the change.
   Staging and production have separate Cognito domains and user pools; register
   each required Cognito redirect URI with Google.

The CRM callbacks and logout destinations use the root URL for their own
environment: `https://staging.d2d4g940z91vj4.amplifyapp.com/` on staging,
`https://app.protectmyhoa.com/` on production, and
`http://localhost:5173/` for a local sandbox. Update the auth URL configuration
when changing CRM domains. Google returns users to the CRM root.

The staging Google Cloud project is `protectmyhoa-crm-staging` (HOA CRM Staging),
managed by the business Google account. The older `hoas-448114` project is
separate and is not used by this staging setup.
The Google client is named `HOA CRM Staging`. Its audience is **External /
Testing**, with `jake@getgim.com` as the test user. Another staging tester must
be added to Google's test-user list as well as invited to the CRM team.

The existing staging AWS app is `d2d4g940z91vj4` in `us-east-1`. Its deterministic
Cognito origin is
`https://231bd86184627538ae01.auth.us-east-1.amazoncognito.com`, and its Google
redirect URI is
`https://231bd86184627538ae01.auth.us-east-1.amazoncognito.com/oauth2/idpresponse`.
These values can be registered with the Google client before deploying the
provider. Staging's existing `EMAIL_OTP` invitation setting is explicitly
preserved in the backend; production's sign-in factor policy is unchanged.

## Local sandbox

From `crm/`, set each sandbox secret interactively:

```sh
npx ampx sandbox secret set GOOGLE_CLIENT_ID
npx ampx sandbox secret set GOOGLE_CLIENT_SECRET
GOOGLE_SIGN_IN_ENABLED=true npx ampx sandbox
```

Register that sandbox's Cognito origin and `/oauth2/idpresponse` URI with the
Google client too, then run `npm run dev`. Keep `AWS_BRANCH` unset for local
development so the backend uses the localhost callback. Use the localhost
port shown above.

## Verify before promoting

- Invite a Gmail or Google Workspace teammate in staging. Sign in with Google,
  complete any first-login onboarding, and check that the team roster contains
  the original member with the same user ID and roles. For an existing member,
  confirm that their profile and assigned accounts still load.
- Sign out, sign in again with Google, and confirm the session restores after a
  reload. Sign out again and confirm an email link still signs into that same
  account.
- Try an uninvited Google account. It must return to sign-in with a safe error,
  without creating a Cognito user or CRM profile. Cancel the Google account
  picker and confirm email sign-in still works.
- Deactivate the invited member as an Owner. Confirm existing CRM access and
  new Google sign-ins are blocked. Reactivate the member and require a new
  sign-in, preserving their previous assignments.
- Confirm the Front sidebar still offers its private email-link sign-in.

Local unit tests and CloudFormation synthesis cover code and infrastructure
configuration. The live Google exchange requires a configured OAuth client
and deployed backend and must be checked separately.

## Disable Google

Remove `GOOGLE_SIGN_IN_ENABLED` or set it to `false`, then redeploy the backend
and frontend together. The Google button and provider are removed; email links
remain available. Keep the mutable Google hosted-domain schema attribute in
the user pool: Cognito custom attributes cannot be removed after creation.
Disabling Google does not itself revoke existing CRM sessions; use the normal
team deactivation controls when access needs to end.

Implementation references:
[Amplify external identity providers](https://docs.amplify.aws/react/build-a-backend/auth/concepts/external-identity-providers/),
[Cognito account linking](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-identity-federation-consolidate-users.html),
and [Cognito pre-sign-up triggers](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-pre-sign-up.html).
