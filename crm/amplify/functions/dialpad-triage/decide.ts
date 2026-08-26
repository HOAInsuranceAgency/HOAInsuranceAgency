import type { TriageAction } from "../../../src/lib/enums";

/**
 * What filing a call actually means, per action.
 *
 * Pure — no data client — so the rules about which arguments each action
 * needs, and what a filing leaves behind, are testable without a table.
 * `handler.ts` does the writing. Same split as the other two Dialpad
 * functions.
 */

export interface TriageRequest {
  communicationId?: string | null;
  action?: TriageAction | null;
  accountId?: string | null;
  leadName?: string | null;
  contactName?: string | null;
  rememberNumber?: boolean | null;
}

/** What the handler should do, once the request is known to make sense. */
export interface TriagePlan {
  /** Accounts the call should appear on. Empty for NOT_CUSTOMER and IGNORE. */
  fileOn: string[];
  /** Create a LEAD account first, and file on it. */
  createLead: { name: string; contactName: string | null } | null;
  /** Write a PhoneLink so the next call from this number resolves itself. */
  remember: boolean;
  /** Write a suppressed PhoneLink so the next call never queues. */
  suppress: boolean;
}

export type TriageDecision =
  | { ok: true; plan: TriagePlan }
  | { ok: false; error: string };

/**
 * Validate a filing request and say what it implies.
 *
 * Every rejection here is a message a person reads, so they say what is
 * missing rather than that something was invalid.
 */
export function decideTriage(req: TriageRequest): TriageDecision {
  if (!req.communicationId) return { ok: false, error: "No call was named." };

  switch (req.action) {
    case "FILE": {
      if (!req.accountId) return { ok: false, error: "Choose an account to file it on." };
      return {
        ok: true,
        plan: {
          fileOn: [req.accountId],
          createLead: null,
          remember: req.rememberNumber === true,
          suppress: false,
        },
      };
    }

    case "NEW_LEAD": {
      const name = (req.leadName ?? "").trim();
      if (!name) return { ok: false, error: "Give the new lead a name." };
      return {
        ok: true,
        plan: {
          fileOn: [],
          createLead: { name, contactName: (req.contactName ?? "").trim() || null },
          // A number that just created a lead IS that lead's number — there is
          // no ambiguity to protect against, so this is not offered as a
          // choice the way it is on FILE.
          remember: true,
          suppress: false,
        },
      };
    }

    case "NOT_CUSTOMER":
      return {
        ok: true,
        plan: { fileOn: [], createLead: null, remember: false, suppress: true },
      };

    case "IGNORE":
      // Clears this one call and leaves nothing behind, so the same number
      // queues again next time. That is the difference from NOT_CUSTOMER and
      // it is the reason both exist.
      return {
        ok: true,
        plan: { fileOn: [], createLead: null, remember: false, suppress: false },
      };

    default:
      return { ok: false, error: "Choose what to do with this call." };
  }
}
