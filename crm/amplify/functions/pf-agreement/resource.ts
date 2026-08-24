import { defineFunction } from "@aws-amplify/backend";

/**
 * Renders the premium finance agreement and the board resolution for a
 * QUOTED loan, and files both through the Documents system so they carry the
 * same permissions and audit trail as everything else on the account.
 *
 * Generation is part of origination, so the module flag is re-checked here —
 * counsel's stop must stop paperwork too — but the jurisdiction gate is NOT
 * re-run: the loan was gated at issuance and its terms are frozen; a state
 * closing afterwards stops new quotes, not the paperwork of approved ones.
 */
export const pfAgreement = defineFunction({
  name: "pf-agreement",
  entry: "./handler.ts",
  timeoutSeconds: 60,
  memoryMB: 512,
  resourceGroupName: "data",
});
