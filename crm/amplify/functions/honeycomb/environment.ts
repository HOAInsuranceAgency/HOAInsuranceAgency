/** Branch deployment selection stays inside the Amplify loader boundary. */
export function honeycombEnvironmentForBranch(branch: string | undefined) {
  return branch === "main" ? "production" : branch === "staging" ? "staging" : "disabled";
}
