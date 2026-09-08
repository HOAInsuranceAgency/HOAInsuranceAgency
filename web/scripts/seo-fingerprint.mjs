import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }
  return resolve(args[index + 1]);
};
const root = option("--root", join(webRoot, "dist"));
const baseline = option("--baseline", join(webRoot, "seo-baseline.json"));

if (!existsSync(root)) throw new Error("No production build. Run npm run build first.");

const pages = [];
function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collect(path);
    else if (entry.name === "index.html") {
      const html = readFileSync(path, "utf8");
      const capture = (expression) => html.match(expression)?.[1] ?? "";
      pages.push({
        url: "/" + relative(root, directory).split(sep).join("/"),
        title: capture(/<title>([\s\S]*?)<\/title>/),
        desc: capture(/<meta\b[^>]*name="description"[^>]*content="([^"]*)"/),
        canonical: capture(/<link\b[^>]*rel="canonical"[^>]*href="([^"]*)"/),
        robots: capture(/<meta\b[^>]*name="robots"[^>]*content="([^"]*)"/),
        h1: [...html.matchAll(/<h1\b[^>]*>/g)].length,
        jsonld: [...html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
          .map((match) => JSON.stringify(JSON.parse(match[1])))
          .join("~"),
      });
    }
  }
}
collect(root);
pages.sort((a, b) => a.url < b.url ? -1 : a.url > b.url ? 1 : 0);
if (pages.length === 0) throw new Error("Production build contains no index.html pages.");

if (args.includes("--save")) {
  writeFileSync(baseline, JSON.stringify(pages, null, 2) + "\n");
  console.log(`Saved reviewed SEO baseline: ${pages.length} HTML pages (including redirects).`);
} else {
  if (!existsSync(baseline)) throw new Error("No baseline. Review the build, then run npm run seo:save.");
  const prior = JSON.parse(readFileSync(baseline, "utf8").replace(/^\uFEFF/, ""));
  const oldRows = new Map(prior.map((page) => [page.url, page]));
  const newRows = new Map(pages.map((page) => [page.url, page]));
  const changes = [...new Set([...oldRows.keys(), ...newRows.keys()])]
    .filter((url) => JSON.stringify(oldRows.get(url)) !== JSON.stringify(newRows.get(url)));
  if (changes.length) {
    console.error(`SEO changed on ${changes.length} page(s):\n${changes.join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: SEO baseline matches all ${pages.length} HTML pages.`);
  }
}
