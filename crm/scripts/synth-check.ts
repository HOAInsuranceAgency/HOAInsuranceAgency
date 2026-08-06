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
 *
 * ## Also does not catch: module resolution
 *
 * This runs under `tsx`, which transpiles any TypeScript it is pointed at.
 * `ampx pipeline-deploy` loads `amplify/backend.ts` with a loader scoped to
 * `amplify/`, so an import reaching OUTSIDE that directory resolves to a
 * module with no exports and the deploy fails with "does not provide an
 * export named 'X'". Deployment 59 died that way on a
 * `../../shared/agency` import that `tsc`, the tests and this script all
 * passed. Lambda handlers are exempt — esbuild bundles those, which is why
 * `renewal-tasks/handler.ts` imports `src/lib/pagination` and always has.
 *
 * So: keep `backend.ts` and everything it imports at synth time inside
 * `amplify/`. If a value has to be shared with the app, read it in the
 * handler rather than passing it down from here. `assertNoEscapingImports`
 * below enforces that, because a note in a comment would not have.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type { App } from "aws-cdk-lib";

const AMPLIFY = resolve(process.cwd(), "amplify");

/**
 * Walk the synth-time import graph from `backend.ts` and reject any relative
 * import that leaves `amplify/`.
 *
 * Handlers are absent from this graph for free: `defineFunction` names its
 * entry as a path *string* (`entry: "./handler.ts"`), so nothing imports a
 * handler at synth time and the walk never reaches one. That is the
 * distinction that matters — handlers are esbuild-bundled at deploy and may
 * import from `src/` and `shared/`, as `renewal-tasks` does.
 */
function assertNoEscapingImports(): void {
  const seen = new Set<string>();
  const bad: string[] = [];

  const resolveFile = (spec: string, from: string): string | null => {
    const base = resolve(dirname(from), spec);
    for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
      if (existsSync(c) && !c.endsWith("/")) return c;
    }
    return null;
  };

  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    // Bare specifiers are packages — node_modules is not the concern here.
    for (const m of src.matchAll(/^\s*import\s[^'"]*?['"](\.[^'"]+)['"]/gm)) {
      const target = resolveFile(m[1], file);
      if (!target) continue;
      if (relative(AMPLIFY, target).startsWith("..")) {
        bad.push(`${relative(process.cwd(), file)} → ${m[1]}`);
        continue;
      }
      walk(target);
    }
  };

  walk(join(AMPLIFY, "backend.ts"));

  if (bad.length) {
    console.error(
      "✘ Synth-time import escapes amplify/ — this deploys fine locally and " +
        "fails in the pipeline with \"does not provide an export named …\":\n" +
        bad.map((b) => `    ${b}`).join("\n") +
        "\n\n  Read the value in the Lambda handler instead; handlers are " +
        "bundled by esbuild and have no such limit."
    );
    process.exit(1);
  }
}

assertNoEscapingImports();

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
