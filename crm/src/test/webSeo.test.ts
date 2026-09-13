import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  AGENCY,
  AGENCY_FMT,
  FOUNDER_PROFILES,
} from "../../../shared/agency";
import {
  SITE_ORIGIN,
  ORG_ID,
  BRAND_ID,
  WEBSITE_ID,
  FOUNDER_ID,
  SPECIALIST_ID,
  canonicalUrl,
  absoluteUrl,
  organizationSchema,
  brandSchema,
  websiteSchema,
  webPageSchema,
  personFounder,
  personSpecialist,
  faqPageSchema,
  breadcrumbSchema,
  siteGraph,
} from "../../../web/src/lib/seo";
import {
  NOINDEX_ROUTE_PREFIXES,
  isNoindexRoute,
} from "../../../web/src/data/routes";
import { MARKETS } from "../../../web/src/data/markets";
import { STAGES } from "../../../web/src/data/process";

/**
 * Regression tests for the marketing site's canonical URLs and entity graph.
 *
 * They live in `crm/` for the same reason `sharedAgency.test.ts` does: Vitest is
 * configured here only, and `crm`'s `include: ["src"]` is what pulls the
 * repo-root and `web/` modules into `tsc -b`. `web/src/lib/seo.ts` is
 * deliberately framework-free so it can be imported and asserted on directly —
 * these run against the REAL graph the site ships, not a copy of it.
 *
 * What each group is defending against, all of which was live in production
 * before this suite existed:
 *   · canonicals that omitted the trailing slash production 301-redirects to,
 *     so every page's self-referential canonical named a redirecting URL;
 *   · a second, disconnected `InsuranceAgency` node emitted from a second
 *     template, so the site published two unrelated agencies;
 *   · `areaServed` frozen at six states while the visible copy said 51;
 *   · a founder who appeared nowhere, under three names that nothing connected;
 *   · a sitemap advertising URLs that serve `noindex`.
 */

const read = (relToThisFile: string) =>
  readFileSync(new URL(relToThisFile, import.meta.url), "utf8");

/** Flatten the graph a page ships into a list of nodes. */
const nodesOf = (graph: Record<string, unknown>) =>
  graph["@graph"] as Record<string, unknown>[];

const HOME = siteGraph({
  canonical: canonicalUrl("/"),
  title: "Home",
  description: "d",
});

describe("canonical URLs", () => {
  it("uses the www host production actually serves", () => {
    // The apex 302s to www; www serves 200. A canonical must never name a host
    // that redirects, and every @id in the graph is rooted at this origin.
    expect(SITE_ORIGIN).toBe("https://www.protectmyhoa.com");
    expect(SITE_ORIGIN).toBe(AGENCY.site);
    expect(SITE_ORIGIN.startsWith("https://www.")).toBe(true);
  });

  it("normalises every shape a page might pass to the trailing-slash form", () => {
    // The defect this replaces: pages passed "/about-us", production 301'd it to
    // "/about-us/", and the sitemap listed the slashed form — so the canonical
    // and the sitemap disagreed on all 46 submitted URLs. Any input shape must
    // now produce the one URL that returns 200.
    expect(canonicalUrl("")).toBe("https://www.protectmyhoa.com/");
    expect(canonicalUrl("/")).toBe("https://www.protectmyhoa.com/");
    expect(canonicalUrl("/about-us")).toBe(
      "https://www.protectmyhoa.com/about-us/"
    );
    expect(canonicalUrl("/about-us/")).toBe(
      "https://www.protectmyhoa.com/about-us/"
    );
    expect(canonicalUrl("about-us")).toBe(
      "https://www.protectmyhoa.com/about-us/"
    );
    expect(canonicalUrl("/get-started/massachusetts")).toBe(
      "https://www.protectmyhoa.com/get-started/massachusetts/"
    );
  });

  it("never emits a canonical without a trailing slash", () => {
    for (const path of [
      "",
      "/",
      "/about-us",
      "/contact/",
      "/hoa-insurance-texas",
      "/hoa-insurance-boston-ma/",
    ]) {
      expect(canonicalUrl(path).endsWith("/")).toBe(true);
      expect(canonicalUrl(path).startsWith(`${SITE_ORIGIN}/`)).toBe(true);
    }
  });

  it("resolves asset paths absolutely and passes absolute URLs through", () => {
    expect(absoluteUrl("/logo.png")).toBe(
      "https://www.protectmyhoa.com/logo.png"
    );
    expect(absoluteUrl("logo.png")).toBe(
      "https://www.protectmyhoa.com/logo.png"
    );
    expect(absoluteUrl("https://cdn.example.com/x.png")).toBe(
      "https://cdn.example.com/x.png"
    );
  });

  it("agrees with the origin astro.config.mjs declares", () => {
    // Astro's config is evaluated before any path mapping and cannot import
    // shared/agency.ts, so it holds the one unavoidable second copy of the
    // origin. This is the check that keeps the two equal.
    const config = read("../../../web/astro.config.mjs");
    expect(config).toContain(`site: "${SITE_ORIGIN}"`);
    // And the URL contract itself must be declared, or the sitemap and the
    // canonicals are free to disagree again.
    expect(config).toContain('trailingSlash: "always"');
  });

  it("points robots.txt at a sitemap on the canonical host", () => {
    const robots = read("../../../web/public/robots.txt");
    expect(robots).toContain(`Sitemap: ${SITE_ORIGIN}/sitemap-index.xml`);
    expect(robots).not.toMatch(/Sitemap:\s*https:\/\/protectmyhoa\.com/);
  });
});

describe("agency identity — one entity, two names, one brand", () => {
  const org = organizationSchema();

  it("publishes the legal name, the public name and the brand on ONE node", () => {
    expect(org["@type"]).toBe("InsuranceAgency");
    expect(org["@id"]).toBe(`${SITE_ORIGIN}/#organization`);
    expect(org.name).toBe("HOA Insurance Agency");
    expect(org.legalName).toBe("HOA Insurance Agency LLC");
    expect(org.alternateName).toBe("ProtectMyHOA");
  });

  it("carries the founding date, the full address, the phone and the general email", () => {
    expect(org.foundingDate).toBe("2025-12-30");
    expect(org.telephone).toBe(AGENCY_FMT.phoneIntl);
    // The GENERAL address, not the sales one. `sales@` is where website leads
    // are delivered; the entity's published contact is `insurance@`.
    expect(org.email).toBe("insurance@ProtectMyHOA.com");
    expect(org.email).not.toBe(AGENCY.leadEmail);
    expect(org.address).toEqual({
      "@type": "PostalAddress",
      streetAddress: "420 Lakeside Ave, Suite 202",
      addressLocality: "Marlborough",
      addressRegion: "MA",
      postalCode: "01752",
      addressCountry: "US",
    });
  });

  it("names no address other than Suite 202", () => {
    // The Massachusetts licensing list still carries 11 Apex Drive, Suite 300A,
    // Box 1067, and a New York foreign registration may show an Albany
    // registered agent. Neither is an operating office and neither may reach
    // the published entity.
    const json = JSON.stringify(HOME);
    for (const stale of [
      "Apex",
      "300A",
      "Box 1067",
      "Albany",
      "418 Broadway",
      "squarespace",
    ]) {
      expect(json).not.toContain(stale);
    }
  });

  it("models ProtectMyHOA as a Brand of the agency, never as a second agency", () => {
    const brand = brandSchema();
    expect(brand["@type"]).toBe("Brand");
    expect(brand["@id"]).toBe(BRAND_ID);
    expect(brand.name).toBe("ProtectMyHOA");
    // Points back at the one organization...
    expect(brand.parentOrganization).toEqual({ "@id": ORG_ID });
    // ...and carries none of the regulated attributes an agency would have.
    for (const forbidden of [
      "address",
      "telephone",
      "founder",
      "areaServed",
      "legalName",
      "email",
    ]) {
      expect(brand).not.toHaveProperty(forbidden);
    }
    // The organization completes the round trip.
    expect(organizationSchema().brand).toEqual({ "@id": BRAND_ID });
  });

  it("names the website for the brand and publishes it as the agency", () => {
    const site = websiteSchema();
    expect(site["@type"]).toBe("WebSite");
    expect(site["@id"]).toBe(WEBSITE_ID);
    expect(site.name).toBe("ProtectMyHOA");
    expect(site.publisher).toEqual({ "@id": ORG_ID });
  });

  it("ties each page to the site and to its own canonical URL", () => {
    const canonical = canonicalUrl("/about-us");
    const page = webPageSchema({
      canonical,
      title: "About",
      description: "d",
    });
    expect(page["@type"]).toBe("WebPage");
    expect(page["@id"]).toBe(`${canonical}#webpage`);
    expect(page.url).toBe(canonical);
    expect(page.isPartOf).toEqual({ "@id": WEBSITE_ID });
    expect(page.publisher).toEqual({ "@id": ORG_ID });
  });

  it("emits exactly ONE agency node per page, with a stable @id", () => {
    // The regression: `get-started/[...slug].astro` used to hand-roll a second,
    // standalone InsuranceAgency object with no @id, so the eight pages the ad
    // budget points at published a different, unconnected company. Every
    // template now renders this one graph.
    for (const path of ["/", "/about-us", "/contact", "/quote", "/get-started"]) {
      const nodes = nodesOf(
        siteGraph({ canonical: canonicalUrl(path), title: "t", description: "d" })
      );
      const agencies = nodes.filter((n) =>
        ["InsuranceAgency", "Organization", "LocalBusiness", "FinancialService"].includes(
          n["@type"] as string
        )
      );
      expect(agencies).toHaveLength(1);
      expect(agencies[0]["@id"]).toBe(ORG_ID);
    }
  });

  it("publishes no rating or review markup", () => {
    // The Google Business Profile reportedly carries eight five-star reviews.
    // Self-serving review markup on an organization is against Google's policy
    // and there is no eligible visible review content on the site.
    const json = JSON.stringify(HOME);
    for (const banned of [
      "aggregateRating",
      '"Review"',
      "reviewRating",
      "ratingValue",
    ]) {
      expect(json).not.toContain(banned);
    }
  });

  it("asserts sameAs only for profiles identifying the agency", () => {
    const sameAs = org.sameAs as string[];
    expect(sameAs).toEqual([
      "https://www.instagram.com/hoainsuranceagency",
      "https://www.facebook.com/people/HOA-Insurance-Agency/61575377498498/",
      "https://www.linkedin.com/company/hoa-insurance-agency",
      "https://www.wikidata.org/wiki/Q141443333",
    ]);
    expect(JSON.stringify(HOME)).not.toContain("jakegreasley.com");
  });
});

describe("national service area", () => {
  it("declares the United States, not a six-state list", () => {
    expect(organizationSchema().areaServed).toEqual({
      "@type": "Country",
      name: "United States",
    });
  });

  it("carries no trace of the obsolete six-state footprint", () => {
    // MA/RI/NH/CT/NY/OK was emitted on every page, including all 51 state
    // pages — so a Texas page shipped schema saying the agency does not serve
    // Texas. Nothing in the graph may name a state as a service-area limit.
    const json = JSON.stringify(HOME);
    expect(json).not.toContain('"State"');
    for (const state of [
      "Rhode Island",
      "New Hampshire",
      "Connecticut",
      "Oklahoma",
    ]) {
      expect(json).not.toContain(state);
    }
  });

  it("states the real footprint in the description the site publishes", () => {
    expect(AGENCY.areaServed).toBe(
      "all 50 states and the District of Columbia"
    );
    expect(organizationSchema().description).toContain(
      "all 50 states and the District of Columbia"
    );
  });

  it("keeps the brand sentence derived from the two names, not typed out", () => {
    expect(AGENCY_FMT.brandLine).toBe(
      "ProtectMyHOA is the consumer-facing brand of HOA Insurance Agency LLC."
    );
    expect(AGENCY_FMT.brandLine).toContain(AGENCY.brandName);
    expect(AGENCY_FMT.brandLine).toContain(AGENCY.name);
  });
});

describe("the founder — three names, one person", () => {
  const jake = personFounder();

  it("resolves Jake, Jacob and Jacob Charles Greasley to a single entity", () => {
    expect(jake["@type"]).toBe("Person");
    expect(jake["@id"]).toBe(FOUNDER_ID);
    expect(jake.name).toBe("Jake Greasley");
    expect(jake.alternateName).toEqual([
      "Jacob Greasley",
      "Jacob Charles Greasley",
    ]);
    expect(jake.jobTitle).toBe("Founder and President");
  });

  it("anchors the Person at a section the About page actually renders", () => {
    // Structured data may not assert what the page does not show. The anchor
    // and the visible copy are two halves of one claim.
    expect(FOUNDER_ID).toBe(
      "https://www.protectmyhoa.com/about-us/#jake-greasley"
    );
    const aboutUs = read("../../../web/src/pages/about-us.astro");
    expect(aboutUs).toContain('id="jake-greasley"');
    expect(aboutUs).toContain("founderDisplayName");
    expect(aboutUs).toContain("founderLegalName");
    expect(aboutUs).toContain("founderJobTitle");
    expect(aboutUs).toContain(">Founder and President</h2>");
    expect(aboutUs).not.toContain("AGENCY.contactName");
    expect(aboutUs).not.toContain("no personal-lines or commercial side");
  });

  it("links founder and organization in both directions, by the same @id", () => {
    expect(organizationSchema().founder).toEqual({ "@id": FOUNDER_ID });
    expect(jake.worksFor).toEqual({ "@id": ORG_ID });
  });

  it("publishes the confirmed title without unrelated credentials", () => {
    expect(jake.jobTitle).toBe(AGENCY.founderJobTitle);
    const json = JSON.stringify(jake);
    for (const banned of [
      "Producer",
      "CEO",
      "Principal",
      "CFA",
      "NPN",
    ]) {
      expect(json.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });

  it("publishes every approved founder profile in schema and visible copy", () => {
    const urls = FOUNDER_PROFILES.map((profile) => profile.url);
    expect(urls).toEqual([
      "https://www.linkedin.com/in/jake-greasley",
      "https://www.instagram.com/jake.greasley/",
      "https://github.com/JakeGreasleyGIM",
      "https://ma.exprealty.com/agents/1903443/Jacob+Greasley",
      "https://directories.apps.realtor/memberDetail/?personId=4940266&officeStreetCountry=US&memberLastName=Greasley",
      "https://www.realtor.com/realestateagents/656d3c88398ad2f645a8b94b",
    ]);
    expect(jake.sameAs).toEqual([
      ...urls,
      "https://www.wikidata.org/wiki/Q141443360",
    ]);
    const aboutUs = read("../../../web/src/pages/about-us.astro");
    expect(aboutUs).toContain("FOUNDER_PROFILES.map");
    expect(aboutUs).toContain("href={profile.url}");
    expect(aboutUs).toContain("{profile.label}");
    for (const profile of FOUNDER_PROFILES) {
      expect(profile.url).not.toContain("jakegreasley.com");
    }
  });

  it("keeps the local founder id until the apex personal entity is live", () => {
    expect(FOUNDER_ID).not.toContain("jakegreasley.com");
    expect(JSON.stringify(jake.sameAs)).not.toContain("jakegreasley.com");
    const seoSource = read("../../../web/src/lib/seo.ts");
    expect(seoSource).toContain("https://jakegreasley.com/#person");
    expect(seoSource).not.toContain("https://www.jakegreasley.com/#person");
  });

  it("is never typed as an Organization", () => {
    const people = nodesOf(HOME).filter((n) =>
      JSON.stringify(n).includes("Greasley")
    );
    expect(people).toHaveLength(1);
    expect(people[0]["@type"]).toBe("Person");
  });

  it("appears exactly once in the page graph", () => {
    const persons = nodesOf(HOME).filter((n) => n["@type"] === "Person");
    expect(persons).toHaveLength(1);
    expect(persons[0]["@id"]).toBe(FOUNDER_ID);
  });
});

describe("the /contact specialist", () => {
  const brian = personSpecialist({
    name: "Brian Cole",
    jobTitle: "Licensed Insurance Producer",
    image: "/images/brian-cole.jpg",
  });

  it("is a separate Person at a separate stable @id", () => {
    expect(brian["@type"]).toBe("Person");
    expect(brian["@id"]).toBe(SPECIALIST_ID);
    expect(brian["@id"]).not.toBe(FOUNDER_ID);
    expect(brian.worksFor).toEqual({ "@id": ORG_ID });
    expect(brian.image).toBe(
      "https://www.protectmyhoa.com/images/brian-cole.jpg"
    );
  });

  it("does not publish specialist metadata after the contact card is removed", () => {
    const contact = read("../../../web/src/pages/contact.astro");
    expect(contact).not.toContain("personSpecialist");
    expect(contact).not.toContain("specialistJsonLd");
    expect(contact).not.toContain('id="brian-cole"');
    expect(contact).toContain("<ContactForm");
  });

  it("is not merged with the founder", () => {
    const graph = siteGraph({
      canonical: canonicalUrl("/contact"),
      title: "Contact",
      description: "d",
      extra: [brian],
    });
    const persons = nodesOf(graph).filter((n) => n["@type"] === "Person");
    expect(persons).toHaveLength(2);
    expect(new Set(persons.map((p) => p["@id"])).size).toBe(2);
  });
});

describe("owner-confirmed market and service commitments", () => {
  it("describes twelve direct appointments without promising universal availability", () => {
    expect(MARKETS).toHaveLength(12);
    expect(STAGES.find((stage) => stage.title === "Compare")?.desc).toContain(
      "our directly appointed markets that write your risk"
    );
    for (const page of ["index.astro", "why-choose-us.astro", "hoa-insurance-[state].astro"]) {
      const source = read(`../../../web/src/pages/${page}`);
      expect(source).toContain("Direct appointments with twelve markets");
      expect(source).toContain("Carrier availability varies by");
      expect(source).toMatch(/not every\s+market is approached on every\s+placement/i);
    }
  });

  it("retains the confirmed response, no-fee and assessment commitments", () => {
    const assessment = read("../../../web/src/components/InstantAssessment.tsx");
    const contact = read("../../../web/src/pages/contact.astro");
    expect(assessment).toContain("within one business day");
    expect(contact).toContain("No broker fee, now or at renewal.");
    for (const deliverable of [
      "Personalized coverage recommendation",
      "Gap analysis vs. your current policy",
      "Comparison of the markets available to your association",
      "Board-ready summary document",
    ]) {
      expect(assessment).toContain(deliverable);
    }
  });
});

describe("the page graph as a whole", () => {
  it("derives the homepage FAQ and WebPage ids from one canonical", () => {
    const canonical = canonicalUrl("/");
    const faq = faqPageSchema(canonical, [{ q: "Question", a: "Answer" }]);
    const graph = siteGraph({
      canonical,
      title: "Home",
      description: "d",
      extra: [faq],
    });
    const page = nodesOf(graph).find((node) => node["@type"] === "WebPage");

    expect(faq["@id"]).toBe(`${canonical}#faq`);
    expect(faq.mainEntityOfPage).toEqual({ "@id": `${canonical}#webpage` });
    expect(page?.["@id"]).toBe(`${canonical}#webpage`);

    const home = read("../../../web/src/pages/index.astro");
    const layout = read("../../../web/src/layouts/Layout.astro");
    expect(home).toContain('const HOME_CANONICAL = canonicalUrl("/")');
    expect(home).toContain("faqPageSchema(HOME_CANONICAL, FAQS)");
    expect(home).not.toContain('"https://www.protectmyhoa.com/#faq"');
    expect(layout).toContain('<link rel="canonical" href={canonical} />');
  });

  it("keeps trademark symbols out of structured identity values", () => {
    const json = JSON.stringify(HOME);
    expect(json).not.toContain("™");
    expect(json).not.toContain("®");
    expect(AGENCY_FMT.brandMarkedName).toBe("ProtectMyHOA™");
    for (const node of nodesOf(HOME)) {
      for (const field of ["name", "legalName", "alternateName", "@id", "url"]) {
        const value = node[field];
        if (value !== undefined) {
          expect(JSON.stringify(value)).not.toMatch(/[™®]/);
        }
      }
    }
  });

  it("keeps the homepage allocation guidance conditional", () => {
    const home = read("../../../web/src/pages/index.astro");
    expect(home).not.toContain("The master policy stops at the unit");
    expect(home).not.toContain("the cost lands on the owner through loss assessment");
    expect(home).toContain("The association deductible alone does not determine");
    expect(home).toContain("applicable law");
  });

  it("requires Buildium credentials without source fallbacks", () => {
    const sync = read("../../../web/scripts/sync-buildium.ts");
    expect(sync.includes('requireEnv("BUILDIUM_CLIENT_ID")')).toBe(true);
    expect(sync.includes('requireEnv("BUILDIUM_CLIENT_SECRET")')).toBe(true);
    // Assert booleans so a failing test cannot dump a reintroduced credential.
    expect(/process\.env\.BUILDIUM_CLIENT_(?:ID|SECRET)\s*(?:\|\||\?\?)/.test(sync)).toBe(false);
    expect(/BUILDIUM_CLIENT_(?:ID|SECRET)\s*=\s*["'`]/.test(sync)).toBe(false);

    const example = read("../../../web/.env.example");
    expect(/^BUILDIUM_CLIENT_ID=$/m.test(example)).toBe(true);
    expect(/^BUILDIUM_CLIENT_SECRET=$/m.test(example)).toBe(true);
  });

  it("fails closed before fetching or writing when either Buildium credential is missing", () => {
    const source = read("../../../web/scripts/sync-buildium.ts").replace(
      /import\.meta\.url/g,
      '"file:///isolated/scripts/sync-buildium.ts"'
    );
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    for (const missing of ["BUILDIUM_CLIENT_ID", "BUILDIUM_CLIENT_SECRET"]) {
      let sideEffects = 0;
      let message = "";
      const env: Record<string, string> = {
        BUILDIUM_CLIENT_ID: "test-only-id",
        BUILDIUM_CLIENT_SECRET: "test-only-secret",
      };
      delete env[missing];
      try {
        runInNewContext(compiled, {
          exports: {},
          process: { env, exit: () => sideEffects++ },
          console: { log: () => sideEffects++, error: () => sideEffects++ },
          fetch: () => sideEffects++,
          require: (name: string) => {
            if (name === "node:fs") return {
              existsSync: () => false,
              readFileSync: () => { sideEffects++; return ""; },
              writeFileSync: () => sideEffects++,
              mkdirSync: () => sideEffects++,
            };
            if (name === "node:path") return { resolve: (...parts: string[]) => parts.join("/"), dirname: () => "/isolated/scripts" };
            if (name === "node:url") return { fileURLToPath: () => "/isolated/scripts/sync-buildium.ts" };
            throw new Error("Unexpected import in isolated credential check");
          },
        }, { timeout: 1000 });
      } catch (error) {
        message = String((error as Error).message);
      }
      expect(message === `Missing required environment variable: ${missing}`).toBe(true);
      expect(sideEffects).toBe(0);
    }
  });

  it("uses no registered trademark symbol in production source", () => {
    const repoRoot =
      basename(process.cwd()) === "crm" ? dirname(process.cwd()) : process.cwd();
    const root = join(repoRoot, "web", "src");
    const files: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const child = join(directory, entry.name);
        if (entry.isDirectory()) walk(child);
        else if (/\.(astro|tsx|ts)$/.test(entry.name)) files.push(child);
      }
    };
    walk(root);
    expect(files.filter((file) => readFileSync(file, "utf8").includes("®"))).toEqual([]);
  });

  it("is one valid JSON document with one @context and no nested contexts", () => {
    // A node inside an @graph must not carry its own @context. Page-specific
    // nodes arrive through Layout's `jsonLd` prop, so this is the check that
    // catches a caller pasting a standalone schema object in.
    const graph = siteGraph({
      canonical: canonicalUrl("/what-we-do"),
      title: "t",
      description: "d",
      extra: [{ "@type": "FAQPage", "@id": "x", mainEntity: [] }],
    });
    expect(graph["@context"]).toBe("https://schema.org");
    const json = JSON.stringify(graph);
    expect(() => JSON.parse(json)).not.toThrow();
    for (const node of nodesOf(graph)) {
      expect(node).not.toHaveProperty("@context");
    }
  });

  it("gives every node a stable @id rooted at the canonical origin", () => {
    for (const node of nodesOf(HOME)) {
      const id = node["@id"] as string;
      expect(id, `${node["@type"]} has no @id`).toBeTruthy();
      expect(id.startsWith(SITE_ORIGIN)).toBe(true);
    }
  });

  it("leaves no reference dangling", () => {
    // Every { "@id": ... } reference must name a node that is actually in the
    // graph — otherwise the entity it points at does not exist as far as a
    // consumer is concerned, which is exactly how a founder or a brand silently
    // detaches from its agency.
    const nodes = nodesOf(HOME);
    const declared = new Set<string>();
    const referenced: string[] = [];
    /**
     * A `{ "@id": ... }` with no other key is a REFERENCE; an object that has an
     * `@id` alongside other properties is a DECLARATION — including a nested one
     * such as the organization's logo ImageObject, which is declared inside the
     * organization and referenced from its `image`. Collecting declarations only
     * at the top level would report that perfectly valid pair as dangling.
     */
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        const keys = Object.keys(o);
        if (keys.length === 1 && keys[0] === "@id") {
          referenced.push(o["@id"] as string);
          return;
        }
        if (typeof o["@id"] === "string") declared.add(o["@id"]);
        Object.values(o).forEach(walk);
      }
    };
    nodes.forEach(walk);
    expect(referenced.length).toBeGreaterThan(0);
    for (const ref of referenced) expect(declared).toContain(ref);
  });

  it("orders the graph so the organization is first", () => {
    // Not required by spec, but it is what a human reading View Source expects,
    // and it keeps diffs of the rendered HTML readable.
    expect(nodesOf(HOME)[0]["@id"]).toBe(ORG_ID);
  });

  it("builds breadcrumbs on canonical, trailing-slash URLs", () => {
    const crumbs = breadcrumbSchema([
      { name: "Home", path: "/" },
      { name: "About", path: "/about-us" },
    ]) as Record<string, unknown>;
    const items = crumbs.itemListElement as Record<string, unknown>[];
    expect(items[0].item).toBe("https://www.protectmyhoa.com/");
    expect(items[1].item).toBe("https://www.protectmyhoa.com/about-us/");
    expect(items[1].position).toBe(2);
  });
});

describe("indexing hygiene", () => {
  it("keeps every functional route out of the sitemap", () => {
    for (const prefix of [
      "/documents/",
      "/finance/",
      "/associations/",
      "/get-started/",
      "/quote/",
    ]) {
      expect(NOINDEX_ROUTE_PREFIXES).toContain(prefix);
      expect(isNoindexRoute(`https://www.protectmyhoa.com${prefix}`)).toBe(true);
    }
  });

  it("leaves the pages that should rank alone", () => {
    for (const path of [
      "https://www.protectmyhoa.com/",
      "https://www.protectmyhoa.com/about-us/",
      "https://www.protectmyhoa.com/contact/",
      "https://www.protectmyhoa.com/what-we-do/",
      "https://www.protectmyhoa.com/why-choose-us/",
      "https://www.protectmyhoa.com/privacy-policy/",
      "https://www.protectmyhoa.com/terms-of-service/",
      "https://www.protectmyhoa.com/hoa-insurance-massachusetts/",
      "https://www.protectmyhoa.com/hoa-insurance-boston-ma/",
    ]) {
      expect(isNoindexRoute(path)).toBe(false);
    }
  });

  it("is the same list the sitemap filter reads", () => {
    // Two places used to decide this and they disagreed, so the sitemap
    // submitted two URLs that serve `noindex`. One list, read by both.
    const config = read("../../../web/astro.config.mjs");
    expect(config).toContain("isNoindexRoute");
    expect(config).toContain("./src/data/routes.ts");
  });

  it("writes every internal link in the trailing-slash form", () => {
    // Production 301s the slashless form, so a slashless internal href makes
    // every navigation click a redirect hop — 332 of them pointed at /quote
    // alone. The canonical, the sitemap and the links must all name the one URL
    // that returns 200.
    //
    // Scans SOURCE rather than the build, so it runs without one. It catches the
    // literal-attribute form; a link assembled at runtime from a slug is covered
    // by the templates' own `${slug}/` suffix.
    // Resolved from the working directory rather than from `import.meta.url`:
    // under this Vitest environment the URL object `new URL(..., import.meta.url)`
    // produces is not accepted by `fs`'s directory APIs, and a path string is
    // simpler than working around that. Vitest runs with `crm/` as the root.
    const repoRoot =
      basename(process.cwd()) === "crm" ? dirname(process.cwd()) : process.cwd();
    const root = join(repoRoot, "web", "src");
    // Fail loudly rather than passing vacuously on an empty walk if the layout moves.
    expect(existsSync(root), `${root} not found`).toBe(true);
    const files: string[] = [];
    const walk = (d: string) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const child = join(d, entry.name);
        if (entry.isDirectory()) walk(child);
        else if (/\.(astro|tsx|ts)$/.test(entry.name)) files.push(child);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(30);
    const ASSET = /\.(png|jpe?g|svg|mp4|xml|txt|ico|css|js|webmanifest)$/;
    const offenders: string[] = [];
    for (const f of files) {
      for (const m of readFileSync(f, "utf8").matchAll(
        /href="(\/[a-z0-9][^"#?]*)"/g
      )) {
        const href = m[1];
        if (href === "/" || href.endsWith("/") || ASSET.test(href)) continue;
        offenders.push(`${f.split("/web/")[1]}: ${href}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("marks every noindex route in its own template", () => {
    // The sitemap filter removes the URL; the meta tag is what actually
    // de-indexes it. Both halves are required.
    const templates = [
      "../../../web/src/pages/quote.astro",
      "../../../web/src/pages/get-started/[...slug].astro",
      "../../../web/src/pages/associations/[slug].astro",
    ];
    for (const t of templates) {
      expect(read(t)).toMatch(/name="robots" content="noindex/);
    }
  });
});
