import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

describe("data-client Lambdas carry their grants", () => {
  it("every getAmplifyDataClientConfig caller is granted", () => {
    const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
    const SCHEMA = read("amplify/data/resource.ts");
    // dir name → imported symbol, from the schema's own import lines.
    const imports = new Map<string, string>();
    for (const m of SCHEMA.matchAll(
      /import \{ (\w+) \} from "\.\.\/functions\/([\w-]+)\/resource"/g
    )) {
      imports.set(m[2], m[1]);
    }
    const root = resolve(process.cwd(), "amplify/functions");
    const missing: string[] = [];
    for (const dir of readdirSync(root)) {
      const p = resolve(root, dir);
      if (!statSync(p).isDirectory()) continue;
      let handler = "";
      try {
        handler = readFileSync(resolve(p, "handler.ts"), "utf8");
      } catch {
        continue;
      }
      if (!handler.includes("getAmplifyDataClientConfig")) continue;
      const symbol = imports.get(dir);
      if (!symbol || !SCHEMA.includes(`allow.resource(${symbol})`)) {
        missing.push(dir);
      }
    }
    expect(missing, "handlers using the data client without allow.resource()").toEqual([]);
  });
});
