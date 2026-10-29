import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import targets from "../amplify/migration-targets.json" with { type: "json" };
if (process.env.HOA_MIGRATION_PREVIEW === "true") {
  const binding = targets.branches[process.env.AWS_BRANCH];
  if (!binding || ![targets.crmApp, targets.webApp].includes(process.env.AWS_APP_ID) || process.env.HOA_DEPLOY_ACCOUNT_ID !== targets.account) throw new Error("Invalid migration build binding.");
  const crm = process.env.AWS_APP_ID === targets.crmApp;
  if (crm) {
    const outputs = JSON.parse(readFileSync("amplify_outputs.json", "utf8"));
    const m = outputs.custom?.migration;
    if (m?.account !== targets.account || m.appId !== targets.crmApp || m.branch !== process.env.AWS_BRANCH || m.preview !== "true") throw new Error("Generated backend outputs do not match this preview.");
  }
  const origins = {
    "https://www.protectmyhoa.com": `https://${binding.alias}.${targets.webApp}.amplifyapp.com`,
    "https://protectmyhoa.com": `https://${binding.alias}.${targets.webApp}.amplifyapp.com`,
    "https://app.protectmyhoa.com": `https://${binding.alias}.${targets.crmApp}.amplifyapp.com`,
    "https://staging.dx1256wpowwzz.amplifyapp.com": `https://migration-staging.${targets.webApp}.amplifyapp.com`,
    "https://staging.d2d4g940z91vj4.amplifyapp.com": `https://migration-staging.${targets.crmApp}.amplifyapp.com`,
  };
  let count = 0;
  for (const path of readdirSync("dist", { recursive: true })) {
    if (!/\.(html|js|xml|txt)$/.test(path)) continue;
    const file = join("dist", path);
    let text = readFileSync(file, "utf8");
    for (const [source, target] of Object.entries(origins)) text = text.replaceAll(source, target);
    if (path.endsWith(".html")) {
      text = text.replace(/<meta[^>]*name=["']robots["'][^>]*>/gi, "");
      text = text.replace(/<head([^>]*)>/i, '$&<meta name="robots" content="noindex,nofollow,noarchive">');
      text = text.replace(/<body([^>]*)>/i, '$&<aside role="status" style="position:relative;z-index:9999;background:#fff3cd;color:#594500;padding:12px;text-align:center;font:16px system-ui">Migration preview — viewing only. Business actions, messages, uploads and integrations are disabled.</aside>');
      count++;
    }
    writeFileSync(file, text);
  }
  writeFileSync("dist/robots.txt", "User-agent: *\nDisallow: /\n");
  writeFileSync("dist/migration-preview.json", JSON.stringify({ account: targets.account, app: process.env.AWS_APP_ID, branch: process.env.AWS_BRANCH, readOnly: true }));
  console.log(`Verified and isolated ${count} preview HTML pages.`);
}
