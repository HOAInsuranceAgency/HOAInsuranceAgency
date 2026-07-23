/**
 * Buildium → properties.json sync
 *
 * Fetches active associations from Buildium, normalizes them, dedupes
 * slug collisions by appending the Buildium ID, and writes the result
 * to src/data/properties.json.
 *
 * Run with:  npm run sync
 *
 * Required env vars:
 *   BUILDIUM_CLIENT_ID
 *   BUILDIUM_CLIENT_SECRET
 *
 * The script reads from .env (or .env.local) automatically when invoked
 * via `npm run sync` if you've installed dotenv. For ad-hoc runs you can
 * also export them inline:
 *   BUILDIUM_CLIENT_ID=xxx BUILDIUM_CLIENT_SECRET=yyy npm run sync
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/* Try to read .env / .env.local manually (no extra deps) */
function loadDotEnv() {
  const candidates = [".env.local", ".env"];
  for (const name of candidates) {
    const p = resolve(__dirname, "..", name);
    if (!existsSync(p)) continue;
    const raw = readFileSync(p, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = value;
    }
  }
}

loadDotEnv();

const BUILDIUM_BASE_URL =
  process.env.BUILDIUM_BASE_URL || "https://api.buildium.com";
const BUILDIUM_CLIENT_ID =
  process.env.BUILDIUM_CLIENT_ID || "a32ffd58-8115-429e-a623-9a938b94a058";
const BUILDIUM_CLIENT_SECRET =
  process.env.BUILDIUM_CLIENT_SECRET ||
  "Ssh1fB+e1EYz8gLP/kIKKjHRedMkuf+KuCen6kZz2ZU=";

interface BuildiumAddress {
  AddressLine1?: string | null;
  AddressLine2?: string | null;
  City?: string | null;
  State?: string | null;
  PostalCode?: string | null;
}

interface BuildiumAssociation {
  Id: number;
  Name: string;
  IsActive: boolean;
  Address?: BuildiumAddress | null;
}

export interface Property {
  id: number;
  name: string;
  slug: string;
  address: string;
  city: string;
  state: string;
  zip: string;
}

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['']/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .trim();
}

async function fetchAssociations(): Promise<BuildiumAssociation[]> {
  const all: BuildiumAssociation[] = [];
  let offset = 0;
  const limit = 200;

  while (true) {
    const url = `${BUILDIUM_BASE_URL}/v1/associations?status=Active&limit=${limit}&offset=${offset}`;
    const resp = await fetch(url, {
      headers: {
        "x-buildium-client-id": BUILDIUM_CLIENT_ID,
        "x-buildium-client-secret": BUILDIUM_CLIENT_SECRET,
        Accept: "application/json",
      },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Buildium request failed: ${resp.status} ${resp.statusText}\n${body}`);
    }
    const data = (await resp.json()) as BuildiumAssociation[];
    all.push(...data);
    if (data.length < limit) break;
    offset += limit;
  }

  return all;
}

async function main() {
  console.log("Fetching associations from Buildium...");
  const associations = await fetchAssociations();
  console.log(`Received ${associations.length} associations from API`);

  const properties: Property[] = associations
    .filter((a) => a.IsActive && a.Name)
    .map((a) => ({
      id: a.Id,
      name: a.Name,
      slug: toSlug(a.Name),
      address: [a.Address?.AddressLine1, a.Address?.AddressLine2]
        .filter(Boolean)
        .join(", "),
      city: a.Address?.City ?? "",
      state: a.Address?.State ?? "",
      zip: a.Address?.PostalCode ?? "",
    }))
    .filter((p) => p.slug.length > 0);

  // Dedupe slug collisions by appending the Buildium ID
  const slugCounts: Record<string, number> = {};
  for (const p of properties) {
    slugCounts[p.slug] = (slugCounts[p.slug] ?? 0) + 1;
  }
  for (const p of properties) {
    if (slugCounts[p.slug] > 1) {
      p.slug = `${p.slug}-${p.id}`;
    }
  }

  // Sort alphabetically for stable diffs
  properties.sort((a, b) => a.name.localeCompare(b.name));

  const outDir = resolve(__dirname, "../src/data");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, "properties.json");
  writeFileSync(outPath, JSON.stringify(properties, null, 2) + "\n");

  console.log(`Wrote ${properties.length} properties to ${outPath}`);
}

main().catch((err) => {
  console.error("Sync failed:", err);
  process.exit(1);
});
