/** Public endpoint identities only. Credentials remain in branch-scoped secrets. */
export const HONEYCOMB_ENDPOINTS = {
  staging: {
    api: "https://staging-api.honeycombinsurance.com",
    portal: "https://staging-falcon.honeycombinsurance.com",
  },
  production: {
    api: "https://api.honeycombinsurance.com",
    portal: "https://app.honeycombinsurance.com",
  },
} as const;
export type HoneycombEnvironment = keyof typeof HONEYCOMB_ENDPOINTS;
export function isHoneycombEnvironment(value: unknown): value is HoneycombEnvironment {
  return value === "staging" || value === "production";
}
export function honeycombEnvironmentForBranch(branch: string | undefined) {
  return branch === "main" ? "production" : branch === "staging" ? "staging" : "disabled";
}
