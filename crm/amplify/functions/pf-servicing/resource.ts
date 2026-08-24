import { defineFunction } from "@aws-amplify/backend";

/**
 * Loan servicing: activation, payment posting, and the notice sequence.
 *
 * The one property that holds across every action here: the origination gate
 * is never consulted. A jurisdiction closing in the signed file stops new
 * lending; loans that already exist keep servicing, because we cannot
 * un-lend — and a test holds this module to never importing the gate.
 */
export const pfServicing = defineFunction({
  name: "pf-servicing",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  resourceGroupName: "data",
});
