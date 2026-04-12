import { Hero } from "../components/Hero";
import { ContactForm } from "../components/ContactForm";
import { QUOTE_URL } from "../constants";
import "./WhatWeDo.css";

const MASTER_COVERAGES = [
  { title: "Property (Buildings & Common Areas)", items: ["Replacement cost vs. ACV", "Building limit adequacy", "Water and freeze exposure", "Per-unit water deductibles", "Ordinance or law limits", "Equipment breakdown"] },
  { title: "General Liability", items: ["Premises liability (slip & fall)", "Operations liability", "Medical payments and defense costs", "Contractual considerations"] },
  { title: "Umbrella / Excess Liability", items: ["Extends limits above underlying liability policies", "Broader protection for catastrophic claims"] },
  { title: "Directors & Officers (D&O)", items: ["Governance allegations", "Decision disputes", "Wrongful acts and discrimination claims", "Defense costs"] },
  { title: "Crime / Fidelity", items: ["Employee theft", "Forgery", "Computer fraud"] },
];

const COMMON_ISSUES = [
  "Master policy doesn't match bylaws",
  "Building limits are outdated",
  "Ordinance limits are too low",
  "Deductible increases not communicated to unit owners",
  "Missing D&O or crime coverage",
  "Coverage gaps between master policy and HO-6",
];

const HO6_COVERAGES = [
  "Loss assessment coverage limits",
  "Water backup and seepage",
  "Adequate Coverage A for improvements",
  "Personal property limits",
  "Liability limits and umbrella coordination",
];

const FAQS = [
  { q: "What's the difference between an HOA master policy and HO-6?", a: "The master policy covers association-owned buildings, common areas, and shared liability. HO-6 covers unit owner personal property, interior improvements, personal liability, and loss assessment exposure." },
  { q: "Do condo owners need HO-6 insurance?", a: "In most cases, yes. The master policy typically does not cover your personal belongings, interior upgrades, or your share of association deductibles and special assessments." },
  { q: "What should boards review at renewal?", a: "Building valuation, deductible structure, ordinance or law limits, general liability, umbrella, D&O, and crime/fidelity coverage. We prepare a clear summary covering all of these." },
];

export function WhatWeDo() {
  return (
    <>
      <Hero
        title="HOA Insurance"
        subtitle="Specializing in HOA master insurance policies for associations and HO-6 condo unit owner insurance for residents — built to work together."
        backgroundImage="/images/modern-building.jpg"
        compact
      />

      {/* What is a master policy */}
      <section className="section">
        <div className="container">
          <h2 className="section-title">What Is an HOA Master Policy?</h2>
          <p className="wwd-intro">
            An HOA master insurance policy is more than just property coverage. It's a financial and legal protection plan for shared assets, shared liability, and shared decision-making.
          </p>
          <ul className="wwd-bullets">
            <li>Property coverage for buildings and common areas</li>
            <li>General liability for premises and operations</li>
            <li>Optional and added coverages based on need</li>
            <li>Policies differ by building type and governing documents</li>
          </ul>
        </div>
      </section>

      {/* Coverages we place */}
      <section className="section section--alt">
        <div className="container">
          <h2 className="section-title">Key HOA Master Coverages We Place</h2>
          <div className="coverage-list">
            {MASTER_COVERAGES.map((c) => (
              <div key={c.title} className="coverage-block">
                <h3>{c.title}</h3>
                <ul>
                  {c.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Common issues */}
      <section className="section">
        <div className="container">
          <h2 className="section-title">Common HOA Insurance Issues We Help Solve</h2>
          <div className="issues-grid">
            {COMMON_ISSUES.map((issue) => (
              <div key={issue} className="issue-card">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--color-blue)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
                <span>{issue}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* HO-6 */}
      <section className="section section--alt">
        <div className="container ho6-split">
          <div>
            <h2 className="section-title">What Is HO-6 Insurance?</h2>
            <p className="wwd-intro">
              HO-6 insurance is designed for condo unit owners. It covers personal property, unit improvements, personal liability, loss of use, and loss assessment coverage.
            </p>
            <h3 className="wwd-sub-heading">Why HO-6 Matters for Unit Owners in HOAs</h3>
            <p className="wwd-body">
              Unit owners are often surprised by association deductibles, special assessments, and coverage gaps between what the master policy covers and what they're responsible for. A properly structured HO-6 policy helps protect against these exposures.
            </p>
            <h3 className="wwd-sub-heading">HO-6 Coverage We Focus On</h3>
            <ul className="wwd-bullets">
              {HO6_COVERAGES.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
          <div className="ho6-image-wrap">
            <img src="/images/ho6.jpg" alt="Condo building" />
          </div>
        </div>
      </section>

      {/* Master + HO-6 coordination */}
      <section className="section section--navy" style={{ textAlign: "center" }}>
        <div className="container">
          <h2 className="section-title">Master Policy + HO-6 Coordination</h2>
          <p className="section-subtitle" style={{ margin: "0 auto 32px" }}>
            The best outcomes happen when boards understand the master policy structure and unit owners carry HO-6 coverage aligned with that structure. We help both sides get there.
          </p>
          <div style={{ display: "flex", gap: 16, justifyContent: "center", flexWrap: "wrap" }}>
            <a href={QUOTE_URL} className="btn btn-white">Request an HOA Review</a>
            <a href={QUOTE_URL} className="btn btn-outline">Get an HO-6 Quote</a>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="section">
        <div className="container">
          <h2 className="section-title">Frequently Asked Questions</h2>
          <div className="faq-list">
            {FAQS.map((f) => (
              <details key={f.q} className="faq-item">
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <ContactForm />
    </>
  );
}
