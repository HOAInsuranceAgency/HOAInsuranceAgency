import { execFileSync } from "node:child_process";
import targets from "../amplify/migration-targets.json" with { type: "json" };
// Hosted Git branches are retained independently of their short, immutable
// CloudFormation backend namespace. Amplify associates that stack with a dormant
// main/staging branch whose name matches the stack ARN; the hosted migration
// branch reads the generated outputs without a mismatched console association.
// Never create a replacement backend at cutover.
const branch = process.env.AWS_BRANCH ?? "";
const binding = targets.branches[branch];
execFileSync("node", ["scripts/assert-migration-destination.mjs"], { stdio: "inherit" });
if (binding && process.env.AWS_APP_ID !== targets.crmApp) throw new Error("Only the CRM app owns a backend.");
execFileSync("npx", ["ampx", "pipeline-deploy", "--branch", binding?.backendBranch ?? branch, "--app-id", process.env.AWS_APP_ID], { stdio: "inherit" });
