import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { load } from "js-yaml";

const filePath = (relativePath: string) => fileURLToPath(new URL(relativePath, import.meta.url));
const read = (relativePath: string) => readFileSync(filePath(relativePath), "utf8");
const script = filePath("../../../web/scripts/seo-fingerprint.mjs");
let directory: string;
let build: string;
let baseline: string;
const html = (title: string) => `<html><head><title>${title}</title><meta name="description" content="Agency"><link rel="canonical" href="https://www.protectmyhoa.com/"><script type="application/ld+json">{"@graph":[{"@type":"InsuranceAgency"}]}</script></head><body><h1>ProtectMyHOA</h1></body></html>`;
const run = (...args: string[]) => spawnSync(process.execPath, [
  script, "--root", build, "--baseline", baseline, ...args,
], { encoding: "utf8" });

describe("cross-platform SEO fingerprint", () => {
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "hoa-seo-test-"));
    build = join(directory, "dist");
    baseline = join(directory, "baseline.json");
    mkdirSync(build);
    writeFileSync(join(build, "index.html"), html("HOA — Insurance"));
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("round-trips UTF-8 and matches an unchanged build", () => {
    expect(run("--save").status).toBe(0);
    const rows = JSON.parse(readFileSync(baseline, "utf8"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ url: "/", title: "HOA — Insurance", h1: 1 });
    expect(JSON.parse(rows[0].jsonld)["@graph"][0]["@type"]).toBe("InsuranceAgency");
    expect(run().status).toBe(0);
  });

  it("fails with the affected route when an SEO field changes", () => {
    expect(run("--save").status).toBe(0);
    writeFileSync(join(build, "index.html"), html("Changed title"));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SEO changed on 1 page(s):\n/");
  });

  it("detects a newly generated route", () => {
    expect(run("--save").status).toBe(0);
    mkdirSync(join(build, "new-page"));
    writeFileSync(join(build, "new-page", "index.html"), html("New page"));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("/new-page");
  });

  it("refuses to save an empty build as the reviewed baseline", () => {
    rmSync(join(build, "index.html"));
    expect(run("--save").status).toBe(1);
  });
});

describe("Astro 7 build compatibility", () => {
  it("provides a custom-header configuration for every independently deployed app", () => {
    const build = load(read("../../../amplify.yml")) as {
      applications: { appRoot: string }[];
    };
    const headers = load(read("../../../customHttp.yml")) as {
      applications: { appRoot: string; customHeaders: unknown[] }[];
    };
    for (const app of build.applications) {
      const matches = headers.applications.filter((entry) => entry.appRoot === app.appRoot);
      expect(matches, app.appRoot).toHaveLength(1);
      expect(Array.isArray(matches[0].customHeaders), app.appRoot).toBe(true);
      expect(matches[0].customHeaders.length, app.appRoot).toBeGreaterThan(0);
    }
  });

  it("passes visible trademark text to Hero without double-encoding it", () => {
    for (const page of ["index", "what-we-do", "why-choose-us", "hoa-insurance-[state]"]) {
      const source = read(`../../../web/src/pages/${page}.astro`);
      expect(source).toContain('eyebrow="ProtectMyHOA™"');
      expect(source).not.toContain('eyebrow="ProtectMyHOA&trade;"');
    }
  });

  it("selects supported Node 22 for both Amplify jobs and local web development", () => {
    const web = JSON.parse(read("../../../web/package.json"));
    const amplify = read("../../../amplify.yml");
    expect(web.engines.node).toBe(">=22.12.0");
    expect(web.scripts.typecheck).toContain("astro check");
    expect(read("../../../web/.nvmrc").trim()).toBe("22");
    expect(amplify.match(/nvm install 22/g)).toHaveLength(2);
    expect(amplify.match(/nvm use 22/g)).toHaveLength(2);
  });
});
