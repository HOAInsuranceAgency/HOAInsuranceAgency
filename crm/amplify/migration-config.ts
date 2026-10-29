import targets from "./migration-targets.json";

const branch = process.env.AWS_BRANCH ?? "";
const retained = targets.branches[branch as keyof typeof targets.branches];
export const migrationDestination = !!retained;
export const migrationPreview = migrationDestination && process.env.HOA_MIGRATION_PREVIEW === "true";
export const businessBranch = retained?.businessEnvironment ?? branch;
export const migrationCrmOrigin = retained ? `https://${retained.alias}.${targets.crmApp}.amplifyapp.com` : "";
export const migrationWebOrigin = retained ? `https://${retained.alias}.${targets.webApp}.amplifyapp.com` : "";
export const migrationStreamPhase = process.env.HOA_MIGRATION_STREAM_PHASE ?? "quarantine";
export const migrationSchedulesEnabled = process.env.HOA_MIGRATION_SCHEDULES_ENABLED === "true";
export const providerBranch = migrationPreview ? "migration-disabled" : businessBranch;
export { targets as migrationTargets };

if (migrationDestination) {
  if (!["quarantine", "armed"].includes(migrationStreamPhase) || (!migrationPreview && migrationStreamPhase !== "armed")) {
    throw new Error("Migration release requires separately armed stream cursors after the final data sync.");
  }
  if (process.env.AWS_APP_ID !== targets.crmApp || process.env.HOA_DEPLOY_ACCOUNT_ID !== targets.account
    || process.env.HOA_MIGRATION_AUTH !== "true" || !["true", "false"].includes(process.env.HOA_MIGRATION_PREVIEW ?? "")
    || !/^[a-z0-9]+$/.test(targets.crmApp) || !/^[a-z0-9]+$/.test(targets.webApp)) {
    throw new Error("HOA backend deployment is not bound to its approved destination account and retained branch.");
  }
} else if (process.env.HOA_MIGRATION_AUTH === "true" || process.env.HOA_MIGRATION_PREVIEW === "true") {
  throw new Error("Migration configuration must never be applied to the original release branches.");
}
