/** Shared association coverage summaries; issued terms and endorsements control. */
export interface Coverage {
  title: string;
  icon: "building" | "shield" | "umbrella" | "briefcase" | "lock" | "scale" | "home";
  desc: string;
}

export const COVERAGES: Coverage[] = [
  {
    title: "Commercial Property",
    icon: "building",
    desc: "Rebuilds the shared buildings and common elements after a covered loss, typically at replacement cost rather than depreciated value. Equipment breakdown for shared boilers, elevators and HVAC can be written alongside it.",
  },
  {
    title: "General Liability",
    icon: "shield",
    desc: "Responds when someone is hurt on common property, and under a standard form the carrier defends the association as well.",
  },
  {
    title: "Umbrella / Excess Liability",
    icon: "umbrella",
    desc: "Sits above the primary liability limits, for the claim that exceeds them. An umbrella generally follows the underlying forms, so what the primary excludes it usually excludes too.",
  },
  {
    title: "Directors & Officers Liability",
    icon: "briefcase",
    desc: "Responds when a board member is personally named over a governance decision — defence costs are usually the largest part of it.",
  },
  {
    title: "Crime and Fidelity",
    icon: "lock",
    desc: "Covers theft of association funds by an employee or volunteer, and — where the form is extended for it — by a third party. Lender guidelines commonly set a minimum limit based on the funds you hold.",
  },
  {
    title: "Ordinance or Law",
    icon: "scale",
    desc: "Meets the extra cost of rebuilding to today's code after a covered loss, when the original construction no longer complies. It is bought in parts, each with its own limit, and matters most in older buildings.",
  },
  {
    title: "HO-6 Unit Owner Coverage",
    icon: "home",
    desc: "The owner's side of the same arrangement — interior finishes, belongings, personal liability and loss assessment, written against your association's actual master policy. Loss assessment carries its own limit, which is worth reading against the master deductible.",
  },
];
