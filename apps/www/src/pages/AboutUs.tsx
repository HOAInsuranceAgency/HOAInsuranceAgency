import { Link } from "react-router-dom";
import { Hero } from "../components/Hero";
import { ContactForm } from "../components/ContactForm";
import "./AboutUs.css";

const BELIEFS = [
  { title: "Boards deserve clarity", desc: "Insurance should be explained in plain English so board decisions are informed and defensible." },
  { title: "Coverage must match the bylaws", desc: "All-in vs. bare walls — your insurance program must align with governing documents." },
  { title: "Deductibles and limits matter as much as price", desc: "Per-unit deductibles, water losses, and loss assessment exposure need careful attention." },
  { title: "HO-6 coordination is part of the job", desc: "When unit owners understand master policy gaps, it reduces claims conflicts for everyone." },
];

const APPROACH = [
  "Structured renewal timeline",
  "Clean submission data and loss history preparation",
  "Clear coverage summaries for board review",
  "Practical, claims-informed guidance",
  "Long-term approach to risk — not one-year decisions",
];

export function AboutUs() {
  return (
    <>
      <Hero
        title="About Us"
        subtitle="Independent insurance brokerage specializing in HOA master insurance and HO-6 condo unit owner policies."
        backgroundImage="/images/board-meeting.jpg"
        compact
      />

      <section className="section">
        <div className="container about-intro-grid">
          <div className="about-intro-content">
            <h2 className="section-title">Insurance Built for Shared-Ownership Communities</h2>
            <p>
              HOAs have unique requirements — shared buildings, shared liability, board governance, and long-term maintenance realities. We build insurance programs around those realities and explain them in plain English.
            </p>
            <p>
              We're not a generalist agency that happens to sell condo policies. HOA insurance is our focus — the complexities, the underwriting, the board-level conversations.
            </p>
          </div>
          <div className="about-intro-image">
            <img src="/images/about-hero.jpg" alt="Community building" />
          </div>
        </div>
      </section>

      <section className="section section--alt">
        <div className="container">
          <h2 className="section-title">What We Believe</h2>
          <div className="card-grid">
            {BELIEFS.map((b) => (
              <div key={b.title} className="card">
                <h3>{b.title}</h3>
                <p>{b.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <h2 className="section-title">How We Work With Associations</h2>
          <p className="section-subtitle" style={{ marginBottom: 32 }}>
            Our approach is built around the realities of association governance and renewal cycles.
          </p>
          <ul className="approach-list">
            {APPROACH.map((a) => (
              <li key={a} className="approach-item">{a}</li>
            ))}
          </ul>
        </div>
      </section>

      <section className="section section--alt">
        <div className="container">
          <h2 className="section-title">Independent Market Access</h2>
          <p style={{ fontSize: 16, color: "var(--color-gray-600)", lineHeight: 1.7, maxWidth: 720 }}>
            We're not tied to a single insurer. We can access multiple carriers and specialty markets to place the best fit for your association. Coverage is subject to underwriting, policy terms, and eligibility — but our responsibility is consistent: advise the association and place the best program available.
          </p>
          <div style={{ marginTop: 32 }}>
            <Link to="/why-choose-us" className="btn btn-primary">
              Why Choose Us
            </Link>
          </div>
        </div>
      </section>

      <ContactForm />
    </>
  );
}
