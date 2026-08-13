/**
 * The coverages placed on an association program.
 *
 * Extracted from the state page template when the redesign shipped to all 51
 * states — the same move `markets.ts` and `process.ts` already record: a content
 * list that more than one page renders belongs in `data/`, because two copies
 * eventually disagree and here that means a board reading two pages of this site
 * getting two different explanations of the same coverage.
 *
 * The wording is deliberately identical to the six cards on /what-we-do. That
 * page still declares its own `MASTER_COVERAGES` array; switching it to import
 * from here is a one-line change that produces byte-identical HTML, and it is
 * the right follow-up — it is left undone only because /what-we-do currently
 * ranks and that edit deserves its own review rather than riding along with a
 * state-page change.
 *
 * `icon` keys map to the inline SVG set in hoa-insurance-[state].astro. Adding a
 * coverage here without adding its icon renders the card with no mark rather
 * than failing the build, so check both.
 */
export interface Coverage {
  title: string;
  icon: "building" | "shield" | "umbrella" | "briefcase" | "lock" | "scale" | "home";
  desc: string;
}

export const COVERAGES: Coverage[] = [
  {
    title: "Commercial Property",
    icon: "building",
    desc: "Rebuilds the shared buildings and common elements after a covered loss, at replacement cost rather than depreciated value. Includes equipment breakdown for shared boilers, elevators and HVAC.",
  },
  {
    title: "General Liability",
    icon: "shield",
    desc: "Responds when someone is hurt on common property, and pays the cost of defending the association.",
  },
  {
    title: "Umbrella / Excess Liability",
    icon: "umbrella",
    desc: "Sits above the primary liability limits, for the claim that exceeds them.",
  },
  {
    title: "Directors & Officers Liability",
    icon: "briefcase",
    desc: "Defends board members personally when a decision they made is challenged.",
  },
  {
    title: "Crime and Fidelity",
    icon: "lock",
    desc: "Covers theft of association funds, whether by an employee, a volunteer or a third party. Lenders set a minimum limit based on the funds you hold.",
  },
  {
    title: "Ordinance or Law",
    icon: "scale",
    desc: "Pays the extra cost of rebuilding to today's code when the original construction no longer complies, which matters most in older buildings.",
  },
  {
    title: "HO-6 Unit Owner Coverage",
    icon: "home",
    desc: "The owner's side of the same arrangement — interior finishes, belongings, personal liability and loss assessment, written against your association's actual master policy.",
  },
];
