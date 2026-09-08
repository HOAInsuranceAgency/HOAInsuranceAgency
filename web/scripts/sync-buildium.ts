/**
 * Buildium → properties.json sync.
 *
 * Requires BUILDIUM_CLIENT_ID and BUILDIUM_CLIENT_SECRET in the environment or
 * in web/.env.local or web/.env. Credential values must never be committed.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadDotEnv() {
  for (const name of [".env.local", ".env"]) {
    const path = resolve(__dirname, "..", name);
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator < 0) continue;
      const key = trimmed.slice(0, separator).trim();
      let value = trimmed.slice(separator + 1).trim();
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

function requireEnv(name: "BUILDIUM_CLIENT_ID" | "BUILDIUM_CLIENT_SECRET"): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

loadDotEnv();

const BUILDIUM_BASE_URL =
  process.env.BUILDIUM_BASE_URL?.trim() || "https://api.buildium.com";
const BUILDIUM_CLIENT_ID = requireEnv("BUILDIUM_CLIENT_ID");
const BUILDIUM_CLIENT_SECRET = requireEnv("BUILDIUM_CLIENT_SECRET");

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
    .replace(/['’]/g, "")
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
    const response = await fetch(url, {
      headers: {
        "x-buildium-client-id": BUILDIUM_CLIENT_ID,
        "x-buildium-client-secret": BUILDIUM_CLIENT_SECRET,
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      throw new Error(
        `Buildium request failed: ${response.status} ${response.statusText}`
      );
    }
    const data = (await response.json()) as BuildiumAssociation[];
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
    .filter((association) => association.IsActive && association.Name)
    .map((association) => ({
      id: association.Id,
      name: association.Name,
      slug: toSlug(association.Name),
      address: [
        association.Address?.AddressLine1,
        association.Address?.AddressLine2,
      ]
        .filter(Boolean)
        .join(", "),
      city: association.Address?.City ?? "",
      state: association.Address?.State ?? "",
      zip: association.Address?.PostalCode ?? "",
    }))
    .filter((property) => property.slug.length > 0);

  const slugCounts: Record<string, number> = {};
  for (const property of properties) {
    slugCounts[property.slug] = (slugCounts[property.slug] ?? 0) + 1;
  }
  for (const property of properties) {
    if (slugCounts[property.slug] > 1) {
      property.slug = `${property.slug}-${property.id}`;
    }
  }

  properties.sort((a, b) => a.name.localeCompare(b.name));

  const outDir = resolve(__dirname, "../src/data");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, "properties.json");
  writeFileSync(outPath, JSON.stringify(properties, null, 2) + "\n");

  console.log(`Wrote ${properties.length} properties to ${outPath}`);
}

main().catch((error) => {
  console.error("Sync failed:", error);
  process.exit(1);
});
