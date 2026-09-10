import { pathToFileURL } from "node:url";

// GraphQL validates skipped fields but never executes their resolvers. This
// proves schema compatibility without creating a test lead or sending mail.
export const probe = `mutation IntakeContract {
  submitWebLead(name: "", submissionId: "contract-check-no-write", retryProof: "contract-check-no-write-contract-check-no-write", answerSnapshot: "{}", attribution: "{}") @skip(if: true)
}`;
export async function contractReady(url, key, request = fetch) {
  const read = async query => {
    const response = await request(url, { method: "POST", headers: { "content-type": "application/json", "x-api-key": key }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(10000) });
    if (!response.ok) return null;
    const body = await response.json();
    return body.errors?.length ? null : body.data;
  };
  if (await read(probe) == null) return false;
  const state = (await read("query IntakeReadiness { leadIntakeReady(readinessContract: 2) }"))?.leadIntakeReady;
  const ready = typeof state === "string" ? JSON.parse(state) : state;
  return ready?.ready === true && ready.contractVersion >= 2;
}
export async function waitForContract() {
  const url = process.env.PUBLIC_CRM_API_URL, key = process.env.PUBLIC_CRM_API_KEY;
  if (!url || !key) throw new Error("The website deployment needs its CRM endpoint and public API key.");
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    if (await contractReady(url, key).catch(() => false)) { console.log("CRM intake contract is ready; website build can proceed."); return; }
    console.log("Waiting for the CRM intake contract. The deployed website remains available.");
    await new Promise(resolve => setTimeout(resolve, 30000));
  }
  throw new Error("CRM intake contract did not become available. Website deployment stopped; fix the CRM deployment and rerun this build.");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await waitForContract();
