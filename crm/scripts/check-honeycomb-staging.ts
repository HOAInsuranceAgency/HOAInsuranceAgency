/** Explicit staging-only connectivity check. Prints no credentials or request headers. */
import { execFileSync } from "node:child_process";
import { estimate } from "../amplify/functions/honeycomb/client";
const prefix = "/amplify/d2d4g940z91vj4/staging-branch-b4871a2506/";
const names = ["HONEYCOMB_API_USER", "HONEYCOMB_PRODUCER_ID", "HONEYCOMB_API_SECRET_KEY", "HONEYCOMB_API_BASE_URL"];
const response = JSON.parse(execFileSync("aws", ["ssm", "get-parameters", "--region", "us-east-1", "--with-decryption", "--names", ...names.map(name => prefix + name), "--output", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
if (response.InvalidParameters?.length || response.Parameters?.length !== names.length) throw new Error("Staging credentials are incomplete");
for (const parameter of response.Parameters) process.env[parameter.Name.slice(prefix.length)] = parameter.Value;
process.env.HONEYCOMB_ENABLED = "true";
// Synthetic test inputs at the public address shown in Honeycomb's Swagger example.
// Estimation only: no submission, email, SMS or underwriting referral is created.
const started = Date.now();
const result = await estimate({ address: "1600 Amphitheatre Parkway, Mountain View, CA", submissionData: { buildingType: "condominium", grossSQFeet: 1200, replacementValue: 513000 } });
console.log(JSON.stringify({ status: result.status, issue: result.issue, hasEstimationId: !!result.estimationId, hasPrice: !!result.price, elapsedSeconds: Math.round((Date.now()-started)/1000) }));
for (const name of names) delete process.env[name];
if (result.status === "ERROR") process.exitCode = 1;
