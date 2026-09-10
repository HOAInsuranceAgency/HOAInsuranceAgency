/** Fictional local previews only; no API calls and no messages are sent.
 * Run: npx tsx scripts/preview-intake-email.ts [output-directory]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderIntakeBrief } from "../amplify/functions/lead-intake/brief";

const directory = resolve(process.argv[2] || "../docs/previews/lead-email");
mkdirSync(directory, { recursive: true });
const shared = { accountId: "example-account", submissionId: "example-submission", receivedAt: "2026-09-10T02:40:45.788Z", environment: "main", crmBaseUrl: "https://app.protectmyhoa.com" };
const fixtures = {
  ho6: { accountName: "114 Elm Street Condominium", snapshot: { type: "PERSONAL", source: "website-ho6:elm", contactFirstName: "Jane", contactLastName: "Smith", contactEmail: "jane@example.com", contactPhone: "6175550123", address: "114 Elm Street", city: "Worcester", state: "MA", zip: "01609", unitNumber: "4B", currentCarrier: "Example Mutual", answers: { "Building / Association": "114 Elm Street Condominium", Notes: "Our current policy renews next month. Please review our dwelling and loss assessment coverage.\n\nThe best time to reach me is after 3 p.m." } } },
  association: { accountName: "Willow Court Condominium Trust", snapshot: { type: "ASSOCIATION", source: "website-quote", contactFirstName: "Jane", contactLastName: "Smith", contactEmail: "jane@example.com", contactPhone: "6175550123", address: "181 Ruggles Street", city: "Westborough", state: "MA", zip: "01581", unitCount: 33, currentCarrier: "Example Mutual", currentPolicyExpiration: "2027-01-01", answers: { Association: "Willow Court Condominium Trust", Role: "Board Member / Trustee", "Lines to Review": "Commercial Property, General Liability, Directors & Officers Liability, Crime / Fidelity", "Website Agent": "Brian Cole" } } },
};
for (const [name, fixture] of Object.entries(fixtures)) {
  const brief = renderIntakeBrief({ ...shared, ...fixture });
  writeFileSync(resolve(directory, `${name}.html`), brief.html);
}
writeFileSync(resolve(directory, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><title>HOA lead email preview</title><style>
body{margin:0;padding:24px;background:#e8edf3;font:15px Arial;color:#142a4c}header{max-width:1050px;margin:0 auto 24px}h1{font-size:24px;margin:0 0 8px}a{color:#214e76}main{display:flex;gap:28px;align-items:flex-start;justify-content:center;flex-wrap:wrap}iframe{border:1px solid #d3dce7;border-radius:12px;background:#fff}p{line-height:1.6}h2{font-size:15px}section{max-width:100%}
</style></head><body><header><h1>New lead email</h1><p>Fictional examples of the internal email insurance agents receive. <a href="?type=ho6">HO-6 request</a> &nbsp;·&nbsp; <a href="?type=association">Association quote</a></p></header><main><section><h2>Desktop</h2><iframe title="Desktop email preview" width="660" height="1150"></iframe></section><section><h2>Phone</h2><iframe title="Phone email preview" width="360" height="1450"></iframe></section></main><script>const file=new URLSearchParams(location.search).get('type')==='association'?'association.html':'ho6.html';document.querySelectorAll('iframe').forEach(frame=>frame.src=file);</script></body></html>`);
console.log(`Email previews written to ${directory}`);
