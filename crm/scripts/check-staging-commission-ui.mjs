import { spawnSync, execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The repository amplify.yml takes precedence over console build overrides.
// Run these checks before a staging backend deployment, and preserve every exit code.
const mode = process.argv[2];
if (!["check", "build"].includes(mode)) throw new Error("Expected check or build.");
const staging = process.env.AWS_APP_ID === "d1nuh9rw1hcuxo"
  && process.env.AWS_BRANCH === "codex-hoa-staging-migration";
const diagnostics = staging && process.env.HOA_STAGING_BUILD_DIAGNOSTICS === "true";
const group = "/aws/amplify/d1nuh9rw1hcuxo/staging-build";
const stream = `job-${process.env.AWS_JOB_ID || "manual"}-${mode}-${Date.now()}`;
const file = join(tmpdir(), `hoa-build-log-${process.pid}.json`);
function redact(text) {
  for (const [key, value] of Object.entries(process.env)) {
    if (/SECRET|TOKEN|PASSWORD|KEY/i.test(key) && value && value.length >= 8) {
      text = text.split(value).join("[REDACTED]");
    }
  }
  return text;
}
function log(text) {
  if (!diagnostics) return;
  writeFileSync(file, JSON.stringify([{ timestamp: Date.now(), message: redact(text).slice(-180000) }]));
  try {
    execFileSync("aws", ["logs", "put-log-events", "--region", "us-east-1", "--log-group-name", group,
      "--log-stream-name", stream, "--log-events", `file://${file}`], { stdio: "pipe" });
  } finally {
    unlinkSync(file);
  }
}
function run(command, args) {
  const label = command + " " + args.join(" ");
  log("Starting " + label);
  const child = spawnSync(command, args, {
    encoding: "utf8", maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=6144" },
  });
  const output = redact((child.stdout || "") + "\n" + (child.stderr || "") + "\n" + (child.error?.message || ""));
  process.stdout.write(output);
  log(label + "\n" + output + "\nEXIT " + child.status);
  if (child.status !== 0) process.exit(child.status || 1);
}
if (staging && process.env.HOA_DEPLOY_ACCOUNT_ID !== "917680434255") throw new Error("Unexpected staging account.");
if (diagnostics) execFileSync("aws", ["logs", "create-log-stream", "--region", "us-east-1",
  "--log-group-name", group, "--log-stream-name", stream], { stdio: "pipe" });
if (mode === "check" && staging) {
  run("npx", ["ampx", "generate", "outputs", "--app-id", process.env.AWS_APP_ID, "--branch", "staging"]);
  run("npx", ["vitest", "run", "src/pages/Commissions.test.tsx",
    "src/components/CommissionDraftRecovery.test.tsx", "src/components/CommissionWorkQueue.test.tsx", "src/lib/commissionWorkflow.test.tsx",
    "src/test/commissionIntake.test.ts", "src/test/commissionIntakeImport.test.ts", "src/components/CommissionIntake.test.tsx", "src/test/commissionForecast.test.ts", "src/test/commissionService.test.ts",
    "src/test/commissionWorkflow.test.ts", "src/components/CommissionPayroll.test.tsx",
    "src/components/CommissionExceptions.test.tsx", "src/test/reportDownload.test.ts",
    "src/test/commissionBind.test.ts", "src/test/carrierPaymentPreview.test.ts",
    "src/test/commissions.test.ts", "src/test/commissionAccess.test.ts",
    "src/components/QuotesPanel.test.tsx",
    "src/test/sesMailInfrastructure.test.ts", "src/test/sesMailFeedback.test.ts",
    "src/test/sesTransactionalMail.test.ts", "src/test/transactionalMail.test.ts",
    "src/test/magicLinkRequest.test.ts", "src/test/resendCallerContracts.test.ts"]);
  run("npm", ["run", "test:commission-payroll"]);
  run("npx", ["tsc", "-b"]);
}
if (mode === "build") {
  if (staging) run("npm", ["run", "build"]);
  else execFileSync("npm", ["run", "build"], { stdio: "inherit" });
}
