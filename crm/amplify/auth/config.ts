/** CRM entry points shared by email links and Cognito OAuth redirects. */
export const CRM_BRANCH_URLS: Record<string, string> = {
  staging: "https://staging.d2d4g940z91vj4.amplifyapp.com",
  main: "https://app.protectmyhoa.com",
};

export const crmBaseUrl =
  CRM_BRANCH_URLS[process.env.AWS_BRANCH ?? ""] ?? "http://localhost:5173";

// Keep deployments without Google credentials working. Enable per environment
// only after its OAuth client and Amplify secrets have been configured.
export const googleSignInEnabled = process.env.GOOGLE_SIGN_IN_ENABLED === "true";
export const googleRedirectUrls = [`${crmBaseUrl}/`];
