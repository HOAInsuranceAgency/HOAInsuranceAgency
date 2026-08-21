/**
 * GENERATED FILE — do not edit.
 *
 * Source of truth: config/premium_finance/jurisdictions.yml (the signed-off
 * compliance artifact). Regenerate with `npm run pf:generate`. The drift test
 * in jurisdictions.test.ts fails if this file and the YAML disagree, and
 * PF_CONFIG_SHA256 below is the hash of the YAML bytes this was built from —
 * displayed on the admin screen so a running deployment can be checked
 * against the signed file at a glance.
 */

export type PfStatus = "open" | "conditional" | "closed";

export interface PfJurisdiction {
  name: string;
  /** Two-letter USPS code — the form Account.state holds. */
  code: string;
  status: PfStatus;
  /** Percent, e.g. 18.0. Null = no statutory cap. */
  maxApr: number | null;
  /**
   * False = the ceiling is unresolved; the jurisdiction behaves as CLOSED.
   * Null = closed row, not applicable — and deliberately so: a closed→open
   * upgrade starts with no verified value, forcing the ceiling to be
   * re-checked before the row can lend.
   */
  maxAprVerified: boolean | null;
  /** Minimum amount financed. Ohio only. */
  minPrincipal: number | null;
  /** Shown to the user when blocked. */
  note: string;
}

/** SHA-256 of the signed YAML this module was generated from. */
export const PF_CONFIG_SHA256 = "34aeafea72dc89a06ca73f32026c442691f65f7c957cce3f1a74f6c248905187";

export const PF_JURISDICTIONS: readonly PfJurisdiction[] = [
  {
    "name": "Alabama",
    "code": "AL",
    "status": "closed",
    "maxApr": null,
    "maxAprVerified": null,
    "minPrincipal": null,
    "note": "License required; no agent or commercial exemption"
  },
  {
    "name": "Alaska",
    "code": "AK",
    "status": "open",
    "maxApr": 15,
    "maxAprVerified": true,
    "minPrincipal": null,
    "note": "AS 06.40.120 — lowest cap in the country; consider excluding"
  },
  {
    "name": "Arizona",
    "code": "AZ",
    "status": "closed",
    "maxApr": null,
    "maxAprVerified": null,
    "minPrincipal": null,
    "note": "Exemption requires charging no interest"
  },
  {
    "name": "Arkansas",
    "code": "AR",
    "status": "open",
    "maxApr": null,
    "maxAprVerified": false,
    "minPrincipal": null,
    "note": "No PF act, but Amendment 89 ceiling for non-consumer loans unresolved"
  },
  {
    "name": "California",
    "code": "CA",
    "status": "closed",
    "maxApr": null,
    "maxAprVerified": null,
    "minPrincipal": null,
    "note": "Requires a purpose-formed CA corporation"
  },
  {
    "name": "Colorado",
    "code": "CO",
    "status": "open",
    "maxApr": null,
    "maxAprVerified": true,
    "minPrincipal": null,
    "note": "UCCC reaches consumer credit only"
  },
  {
    "name": "Connecticut",
    "code": "CT",
    "status": "closed",
    "maxApr": null,
    "maxAprVerified": null,
    "minPrincipal": null,
    "note": "Unlicensed financing is a class A misdemeanor"
  },
  {
    "name": "Delaware",
    "code": "DE",
    "status": "open",
    "maxApr": 15.9,
    "maxAprVerified": true,
    "minPrincipal": null,
    "note": "$9/$100 add-on; rate binds even when exempt from licensing"
  },
  {
    "name": "District of Columbia",
    "code": "DC",
    "status": "open",
    "maxApr": 24,
    "maxAprVerified": true,
    "minPrincipal": null,
    "note": "§ 31-1101(4) rate safe harbor; nonprofit borrower ceiling"
  },
  {
    "name": "Florida",
    "code": "FL",
    "status": "open",
    "maxApr": 18,
    "maxAprVerified": true,
    "minPrincipal": null,
    "note": "§ 627.901 agent safe harbor — 18% simple or $36/yr"
  },
  {
    "name": "Georgia",
    "code": "GA",
    "status": "closed",
    "maxApr": null,
    "maxAprVerified": null,
    "minPrincipal": null,
    "note": "Exemption void the moment you charge"
  },
  {
    "name": "Hawaii",
    "code": "HI",
    "status": "open",
    "maxApr": null,
    "maxAprVerified": true,
    "minPrincipal": null,
    "note": "No premium finance regime"
  },
  {
    "name": "Idaho",
    "code": "ID",
    "status": "open",
    "maxApr": null,
    "maxAprVerified": true,
    "minPrincipal": null,
    "note": "Credit Code excludes organization debtors"
  },
  {
    "name": "Illinois",
    "code": "IL",
    "status": "closed",
    "maxApr": null,
    "maxAprVerified": null,
    "minPrincipal": null,
    "note": "No agent exemption; 5/513a2 deeming rule"
  },
  {
    "name": "Indiana",
    "code": "IN",
    "status": "open",
    "maxApr": null,
    "maxAprVerified": true,
    "minPrincipal": null,
    "note": "No PF license type at IDOI or DFI"
  },
  {
    "name": "Iowa",
    "code": "IA",
    "status": "open",
    "maxApr": null,
    "maxAprVerified": true,
    "minPrincipal": null,
    "note": "No premium finance chapter"
  },
  {
    "name": "Kansas",
    "code": "KS",
    "status": "open",
    "maxApr": 21.1,
    "maxAprVerified": true,
    "minPrincipal": null,
    "note": "$12/$100/yr add-on ≈ 21.1% APR on 9 pays"
  },
  {
    "name": "Kentucky",
    "code": "KY",
    "status": "closed",
    "maxApr": null,
    "maxAprVerified": null,
    "minPrincipal": null,
    "note": "No agent exemption; $150k net worth"
  },
  {
    "name": "Louisiana",
    "code": "LA",
    "status": "open",
    "maxApr": null,
    "maxAprVerified": true,
    "minPrincipal": null,
    "note": "OFI: no licensing for commercial lines exclusively"
  },
  {
    "name": "Maine",
    "code": "ME",
    "status": "open",
    "maxApr": null,
    "maxAprVerified": true,
    "minPrincipal": null,
    "note": "Supervised lender licence is consumer-only"
  },
  {
    "name": "Maryland",
    "code": "MD",
    "status": "closed",
    "maxApr": null,
    "maxAprVerified": null,
    "minPrincipal": null,
    "note": "§ 23-201(b) expressly names producers"
  },
  {
    "name": "Massachusetts",
    "code": "MA",
    "status": "open",
    "maxApr": null,
    "maxAprVerified": true,
    "minPrincipal": null,
    "note": "c. 255C § 2 — commercial only, own customers only"
  },
  {
    "name": "Michigan",
    "code": "MI",
    "status": "open",
    "maxApr": 21.1,
    "maxAprVerified": true,
    "minPrincipal": null,
    "note": "$12/$100/yr + $18"
  },
  {
    "name": "Minnesota",
    "code": "MN",
    "status": "open",
    "maxApr": null,
    "maxAprVerified": true,
    "minPrincipal": null,
    "note": "Commercial-purpose exclusion"
  },
  {
    "name": "Mississippi",
    "code": "MS",
    "status": "open",
    "maxApr": 24,
    "maxAprVerified": true,
    "minPrincipal": null,
    "note": "24% at or below $10k balance; uncapped above"
  },
  {
    "name": "Missouri",
    "code": "MO",
    "status": "open",
    "maxApr": 26.2,
    "maxAprVerified": true,
    "minPrincipal": null,
    "note": "$15/$100 add-on + $10"
  },
  {
    "name": "Montana",
    "code": "MT",
    "status": "closed",
    "maxApr": null,
    "maxAprVerified": null,
    "minPrincipal": null,
    "note": "Exemption runs to resident producers only"
  },
  {
    "name": "Nebraska",
    "code": "NE",
    "status": "open",
    "maxApr": null,
    "maxAprVerified": true,
    "minPrincipal": null,
    "note": "No premium finance statute"
  },
  {
    "name": "Nevada",
    "code": "NV",
    "status": "open",
    "maxApr": null,
    "maxAprVerified": true,
    "minPrincipal": null,
    "note": "Rate schedule must be filed; set in config before use"
  },
  {
    "name": "New Hampshire",
    "code": "NH",
    "status": "open",
    "maxApr": null,
    "maxAprVerified": true,
    "minPrincipal": null,
    "note": "RSA 415-B:2 IV; rate as agreed"
  },
  {
    "name": "New Jersey",
    "code": "NJ",
    "status": "closed",
    "maxApr": null,
    "maxAprVerified": null,
    "minPrincipal": null,
    "note": "No agent exemption"
  },
  {
    "name": "New Mexico",
    "code": "NM",
    "status": "open",
    "maxApr": null,
    "maxAprVerified": true,
    "minPrincipal": null,
    "note": "§ 59A-45-5(B)(2); no maximum charge section"
  },
  {
    "name": "New York",
    "code": "NY",
    "status": "closed",
    "maxApr": null,
    "maxAprVerified": null,
    "minPrincipal": null,
    "note": "No agent exemption, no commercial carve-out"
  },
  {
    "name": "North Carolina",
    "code": "NC",
    "status": "closed",
    "maxApr": null,
    "maxAprVerified": null,
    "minPrincipal": null,
    "note": "Agent exemption is a late-charge permission only"
  },
  {
    "name": "North Dakota",
    "code": "ND",
    "status": "open",
    "maxApr": null,
    "maxAprVerified": true,
    "minPrincipal": null,
    "note": "Chapter does not apply to insurance producers"
  },
  {
    "name": "Ohio",
    "code": "OH",
    "status": "conditional",
    "maxApr": null,
    "maxAprVerified": true,
    "minPrincipal": 100000,
    "note": "Available only above $100,000 amount financed"
  },
  {
    "name": "Oklahoma",
    "code": "OK",
    "status": "open",
    "maxApr": null,
    "maxAprVerified": true,
    "minPrincipal": null,
    "note": "No PF regime; UCCC is consumer-only"
  },
  {
    "name": "Oregon",
    "code": "OR",
    "status": "open",
    "maxApr": 18,
    "maxAprVerified": true,
    "minPrincipal": null,
    "note": "ORS 746.425(4) producer exemption — 1.5%/month"
  },
  {
    "name": "Pennsylvania",
    "code": "PA",
    "status": "closed",
    "maxApr": null,
    "maxAprVerified": null,
    "minPrincipal": null,
    "note": "Institution-type exemptions only"
  },
  {
    "name": "Rhode Island",
    "code": "RI",
    "status": "open",
    "maxApr": null,
    "maxAprVerified": false,
    "minPrincipal": null,
    "note": "§ 6-26-2 ceiling unread; ch. 19-14.6 may bind"
  },
  {
    "name": "South Carolina",
    "code": "SC",
    "status": "open",
    "maxApr": 18,
    "maxAprVerified": true,
    "minPrincipal": null,
    "note": "§ 38-39-10(d) producer of record — 1.5%/month"
  },
  {
    "name": "South Dakota",
    "code": "SD",
    "status": "closed",
    "maxApr": null,
    "maxAprVerified": null,
    "minPrincipal": null,
    "note": "Money lender licence required"
  },
  {
    "name": "Tennessee",
    "code": "TN",
    "status": "open",
    "maxApr": 24,
    "maxAprVerified": true,
    "minPrincipal": null,
    "note": "24% maximum effective rate"
  },
  {
    "name": "Texas",
    "code": "TX",
    "status": "closed",
    "maxApr": null,
    "maxAprVerified": null,
    "minPrincipal": null,
    "note": "§ 651.001(3)(C) defines the agent as a PFC"
  },
  {
    "name": "Utah",
    "code": "UT",
    "status": "conditional",
    "maxApr": null,
    "maxAprVerified": true,
    "minPrincipal": null,
    "note": "Commercial-financing registration with DFI required first"
  },
  {
    "name": "Vermont",
    "code": "VT",
    "status": "open",
    "maxApr": null,
    "maxAprVerified": true,
    "minPrincipal": null,
    "note": "§ 7002(d); commercial uncapped"
  },
  {
    "name": "Virginia",
    "code": "VA",
    "status": "conditional",
    "maxApr": null,
    "maxAprVerified": true,
    "minPrincipal": null,
    "note": "§ 38.2-1806 credit; permitted charge needs counsel"
  },
  {
    "name": "Washington",
    "code": "WA",
    "status": "closed",
    "maxApr": null,
    "maxAprVerified": null,
    "minPrincipal": null,
    "note": "No agent and no commercial exemption"
  },
  {
    "name": "West Virginia",
    "code": "WV",
    "status": "open",
    "maxApr": null,
    "maxAprVerified": true,
    "minPrincipal": null,
    "note": "No PF act; lending licensure is consumer-only"
  },
  {
    "name": "Wisconsin",
    "code": "WI",
    "status": "open",
    "maxApr": null,
    "maxAprVerified": true,
    "minPrincipal": null,
    "note": "§ 138.12(2)(a); commercial uncapped"
  },
  {
    "name": "Wyoming",
    "code": "WY",
    "status": "open",
    "maxApr": null,
    "maxAprVerified": true,
    "minPrincipal": null,
    "note": "No PF act; UCCC consumer-only"
  }
];

export const PF_COVERAGE_ALLOW: readonly string[] = [
  "Commercial Property",
  "General Liability",
  "Umbrella",
  "Excess Liability",
  "Directors & Officers",
  "Crime",
  "Fidelity",
  "Employee Dishonesty",
  "Workers Compensation",
  "Equipment Breakdown",
  "Boiler & Machinery",
  "Ordinance or Law",
  "Earthquake",
  "Terrorism / TRIA",
  "Cyber",
  "Employment Practices Liability",
  "Commercial Auto",
  "Pollution / Environmental",
  "Builders Risk"
];

export const PF_COVERAGE_DENY: readonly string[] = [
  "HO-3",
  "HO-4",
  "HO-6",
  "Homeowners",
  "Condo Unit Owner",
  "Renters",
  "Personal Umbrella",
  "Personal Auto",
  "Dwelling Fire",
  "Personal Inland Marine"
];
