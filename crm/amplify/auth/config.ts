import { businessBranch, migrationCrmOrigin, migrationDestination, migrationPreview } from "../migration-config";

/** CRM entry points shared by email links and Cognito OAuth redirects. */
export const CRM_BRANCH_URLS: Record<string, string> = {
  staging: "https://staging.d2d4g940z91vj4.amplifyapp.com",
  main: "https://app.protectmyhoa.com",
};

export const crmBaseUrl = migrationDestination
  ? (migrationPreview || businessBranch === "staging" ? migrationCrmOrigin : CRM_BRANCH_URLS.main)
  : CRM_BRANCH_URLS[process.env.AWS_BRANCH ?? ""] ?? "http://localhost:5173";

// This retained staging pool predates Google support. Adding its immutable
// custom schema or linking trigger is a separate auth migration, not mail work.
export const destinationStagingNativeAuth = migrationDestination && businessBranch === "staging";
if (destinationStagingNativeAuth && process.env.GOOGLE_SIGN_IN_ENABLED === "true") {
  throw new Error("Destination staging retains native authentication; Google sign-in requires a separate reviewed migration.");
}

// Keep deployments without Google credentials working. Enable per environment
// only after its OAuth client and Amplify secrets have been configured.
export const googleSignInEnabled = process.env.GOOGLE_SIGN_IN_ENABLED === "true" && !migrationPreview;
export const googleRedirectUrls = [`${crmBaseUrl}/`];
