import { Link } from "react-router-dom";
import { Hero } from "../components/Hero";
import { ContactForm } from "../components/ContactForm";
import { QUOTE_URL } from "../constants";
import "./WhyChooseUs.css";

const DIFFERENTIATORS = [
  {
    title: "HOA-Only Focus",
    desc: "Our niche is community associations — condominiums and condo trusts, HOA boards and trustees, property managers, and unit owners. Specialization leads to better underwriting submissions, clearer renewals, and fewer gaps.",
    bullets: [
      "Condominiums and condo trusts",
      "HOA boards and trustees",
      "Property managers supporting multiple associations",
      "Unit owners seeking HO-6 aligned to master policy",
    ],
  },
  {
    title: "We Think in Systems, Not Policies",
    desc: "HOA insurance is a coordinated program. We help build programs that hold together in a real claim — not just on paper.",
    bullets: [
      "Property + liability + umbrella",
      "D&O + crime + (sometimes) cyber",
      "HO-6 coverage for unit owners",
      "Clear communication around deductibles and assessments",
    ],
  },
  {
    title: "Renewal Strategy That Boards Can Defend",
    desc: "Boards are fiduciaries. Board decisions should be informed, reasonable, and defensible.",
    bullets: [
      "Clear coverage summaries",
      "Deductible and limit rationale",
      "Market options explained plainly",
      "Document-ready recommendations",
    ],
  },
  {
    title: "Unit Owner HO-6 Programs That Reduce Board Headaches",
    desc: "Uncoordinated HO-6 coverage causes confusion after losses. We help reduce that friction.",
    bullets: [
      "Clarifying what the master policy covers",
      "Educating unit owners on HO-6 essentials",
      "Making HO-6 quoting straightforward for residents",
    ],
  },
];

export function WhyChooseUs() {
  return (
    <>
      <Hero
        title="Why Choose Us"
        subtitle="HOA boards need more than a generic insurance quote. Associations face shared ownership, shared liability, shared governance — plus increasingly complex underwriting requirements."
        backgroundImage="/images/hero-people.jpg"
        compact
      />

      <section className="section">
        <div className="container">
          <p className="wcu-intro">
            We specialize in HOA master insurance and HO-6 condo insurance so decisions are clear, practical, and aligned with how associations actually operate.
          </p>
          <div className="wcu-grid">
            {DIFFERENTIATORS.map((d) => (
              <div key={d.title} className="wcu-card">
                <h3>{d.title}</h3>
                <p>{d.desc}</p>
                <ul>
                  {d.bullets.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section section--navy" style={{ textAlign: "center" }}>
        <div className="container">
          <h2 className="section-title">
            If you want an HOA insurance partner built for association renewals and HO-6 coordination, let's talk.
          </h2>
          <div style={{ marginTop: 32, display: "flex", gap: 16, justifyContent: "center", flexWrap: "wrap" }}>
            <a href={QUOTE_URL} className="btn btn-white">Request Insurance Review</a>
            <Link to="/what-we-do" className="btn btn-outline">What We Do</Link>
          </div>
        </div>
      </section>

      <ContactForm />
    </>
  );
}
