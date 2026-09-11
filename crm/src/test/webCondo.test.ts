import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { canonicalUrl, faqPageSchema, siteGraph } from "../../../web/src/lib/seo";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const source = read("../../../web/src/pages/condo-insurance.astro");
const frontmatter = source.split("---")[1].replace(/^import .*;\s*$/gm, "");
// Evaluate the page's actual data and schema with its real framework-free helpers.
const { PAGE_URL, FAQS, faqJsonLd, COMMON_ISSUES, POLICY_TYPES } = runInNewContext(
  `${frontmatter}\n({ PAGE_URL, FAQS, faqJsonLd, COMMON_ISSUES, POLICY_TYPES });`,
  { canonicalUrl, faqPageSchema, QUOTE_URL: "https://quote.example.test/" },
  { timeout: 1000 },
) as {
  PAGE_URL: string;
  FAQS: { q: string; a: string }[];
  faqJsonLd: Record<string, unknown>;
  COMMON_ISSUES: { title: string; desc: string }[];
  POLICY_TYPES: { name: string; covers: string; stops: string; owner: string }[];
};

describe("condominium page release integration", () => {
  it("joins its FAQ to the canonical WebPage in the shared entity graph", () => {
    expect(PAGE_URL).toBe("https://www.protectmyhoa.com/condo-insurance/");
    expect(faqJsonLd["@id"]).toBe(`${PAGE_URL}#faq`);
    expect(faqJsonLd.mainEntityOfPage).toEqual({ "@id": `${PAGE_URL}#webpage` });
    expect(faqJsonLd).not.toHaveProperty("@context");
    const graph = siteGraph({
      canonical: PAGE_URL,
      title: "Condominium Association Insurance",
      description: "Condominium master-policy review",
      extra: [faqJsonLd],
    });
    const nodes = graph["@graph"] as Record<string, unknown>[];
    expect(nodes.filter((node) => node["@type"] === "InsuranceAgency")).toHaveLength(1);
    expect(nodes.filter((node) => node["@type"] === "FAQPage")).toEqual([faqJsonLd]);
    expect(nodes.find((node) => node["@type"] === "WebPage")?.["@id"])
      .toBe(`${PAGE_URL}#webpage`);
    expect(source).toContain('canonicalPath="/condo-insurance/"');
    expect(source).toContain("jsonLd={[faqJsonLd]}");
  });

  it("uses the same questions and answers in the visible FAQ and its schema", () => {
    expect(FAQS).toHaveLength(3);
    expect(faqJsonLd.mainEntity).toEqual(FAQS.map((faq) => ({
      "@type": "Question",
      name: faq.q,
      acceptedAnswer: { "@type": "Answer", text: faq.a },
    })));
    expect(source).toContain("FAQS.map((f) => (");
    expect(source).toContain("<summary>{f.q}</summary>");
    expect(source).toContain("<p>{f.a}</p>");
  });

  it("does not turn a master deductible into an automatic owner bill or HO-6 payment", () => {
    const answer = FAQS.find((faq) => faq.q.includes("Who pays the deductible"))!.a;
    expect(answer).toContain("applicable law");
    expect(answer).toContain("governing documents");
    expect(answer).toContain("allocation provisions");
    expect(answer).toContain("does not automatically become an owner assessment");
    expect(answer).toContain("may respond only if the cause and assessment are covered");
    expect(answer).toContain("terms, exclusions and limits");
    expect(answer).toContain("special limit for a master-policy deductible");
    for (const unqualifiedClaim of [
      "owners are billed their share",
      "the cost is billed to owners",
      "their HO-6 loss assessment cover is what responds",
      "Everything past that line falls to the owner's HO-6",
    ]) {
      expect(source.replace(/\s+/g, " ")).not.toContain(unqualifiedClaim);
    }
    expect(source).toContain("An assessment is not automatic");
  });

  it("requires actual policy review instead of relying on the master-policy label", () => {
    const answer = FAQS[0].a;
    for (const qualifier of [
      "applicable law", "issued master policy", "forms and endorsements",
      "terms, limits and exclusions", "certificate is not a substitute",
    ]) {
      expect(answer).toContain(qualifier);
    }
    expect(source).not.toContain("The governing documents decide, not the policy");
    expect(source).not.toContain("The governing documents decide it, not the insurance policy");
    for (const policy of POLICY_TYPES) expect(policy.stops).toMatch(/Typically excludes/);
    expect(source).toContain("descriptions, not coverage guarantees");
  });

  it("qualifies financing guidance by lender, program, project and review type", () => {
    const answer = FAQS.find((faq) => faq.q.includes("mortgage"))!.a;
    expect(answer).toContain("particular lender's or loan program's");
    expect(answer).toContain("Depending on the project and review type");
    expect(answer).toContain("not identical across all mortgages");
    expect(answer).toContain("lender, which determines loan eligibility");
    expect(source.replace(/\s+/g, " ")).not.toContain("cannot get a normal mortgage");
    expect(COMMON_ISSUES.find((issue) => issue.title.includes("Reserves"))?.desc)
      .toContain("insurance alone does not establish loan eligibility");
  });

  it("renders literal trademarks in Astro string props", () => {
    expect(source).toContain('eyebrow="ProtectMyHOA™"');
    expect(source).toContain('subtitle="Insurance Built for Associations™.');
    expect(source).not.toMatch(/&(?:trade|#8482|#x2122);/i);
  });

  it("uses trailing slashes for all hard-coded internal route links", () => {
    const paths = [...source.matchAll(/href(?::\s*|=)["'](\/[^"']*)["']/g)]
      .map((match) => match[1]);
    expect(paths).toHaveLength(3);
    expect(paths).toEqual(["/contact/", "/contact/", "/contact/"]);
  });

  it("preserves the confirmed no-fee offer and keeps market availability distinct from licensing", () => {
    expect(source.match(/<span class="condo-lead__note">No broker fee<\/span>/g))
      .toHaveLength(2);
    expect(source).toContain("all 50 states and the District of Columbia");
    expect(source).toContain("Coverage availability depends on the");
    expect(source).toContain('backgroundImage="/images/modern-building.jpg"');
    expect(source).not.toContain("backgroundVideo");
    expect(source).toContain('<ContactForm showClaims client:visible />');
  });
});
