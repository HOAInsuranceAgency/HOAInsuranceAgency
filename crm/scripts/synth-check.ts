/**
 * Synthesise the backend locally, the way Amplify's pipeline does.
 *
 *   npm run synth:check
 *
 * ## Why this exists
 *
 * W7 shipped this line in `amplify/backend.ts`:
 *
 *   (table.node.defaultChild as CfnTable).streamSpecification = { … }
 *
 * `npm run typecheck` passed, every test passed, and the staging build failed
 * with `Cannot set properties of undefined (setting 'streamSpecification')` —
 * because an Amplify data table is a `Custom::AmplifyDynamoDBTable` custom
 * resource with no CfnTable default child, and the `as CfnTable` cast asserted
 * away the only evidence a compiler had. Nine commits sat unbuilt behind it.
 *
 * The gap is structural, not a lapse: `tsc` checks types and CDK constructs
 * fail at *construction*, which only happens during synth. So the check is a
 * synth. It needs no AWS credentials and touches nothing — it builds the
 * CloudFormation assembly in a temp directory and throws it away.
 *
 * ## What it does and does not catch
 *
 * Catches: anything that throws while constructing the backend, plus anything
 * CloudFormation-invalid enough to fail assembly — a bad ARN shape, a
 * dangling reference, a construct given a property it does not have.
 *
 * Does not catch: whether the deploy succeeds. A stack can synthesise
 * perfectly and still be rejected — a resource limit, an IAM policy the
 * account will not accept, a DynamoDB table property that cannot be changed on
 * an existing table. Those need a real deploy. This is the cheap gate that
 * removes the class of failure that cost this workstream a week.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "aws-cdk-lib";

// `defineBackend` reads these three from CDK context. The pipeline supplies
// them; a local run has to. The values only name the assembly — nothing is
// contacted and nothing is deployed, so they need to be well-formed rather
// than real.
const outdir = mkdtempSync(join(tmpdir(), "amplify-synth-"));
process.env.CDK_CONTEXT_JSON = JSON.stringify({
  "amplify-backend-namespace": "synth-check",
  "amplify-backend-name": "local",
  "amplify-backend-type": "branch",
});
process.env.CDK_OUTDIR = outdir;

try {
  // Imported for its side effects first: this is where construct constructors
  // run, and where the W7 bug threw.
  const { backend } = await import("../amplify/backend");

  // Then the assembly itself, which is the half an import alone would miss.
  const app = backend.stack.node.root as App;
  const assembly = app.synth();
  const stacks = assembly.stacks.length;

  console.log(`✔ Backend synthesised — ${stacks} stack${stacks === 1 ? "" : "s"}.`);
} catch (err) {
  console.error("✘ Synth failed:", err instanceof Error ? err.message : err);
  console.error(
    "\nThis is what the Amplify build will report. Fix it here rather than " +
      "in a pipeline log."
  );
  process.exitCode = 1;
} finally {
  rmSync(outdir, { recursive: true, force: true });
}
