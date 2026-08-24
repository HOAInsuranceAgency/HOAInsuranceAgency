import { defineFunction } from "@aws-amplify/backend";

/**
 * Origination: the one path that can create a premium finance loan.
 *
 * PfLoan is read-only to every client, so this Lambda's checks cannot be
 * walked around by a direct model write. It re-runs, server-side, everything
 * the browser already showed: the module flag, the jurisdiction gate, the
 * APR cap, the minimum principal, and the four eligibility screens — and it
 * writes one PfComplianceLog row per rule evaluated, pass or block, each
 * stamped with the SHA of the signed ruleset in force. The log rows go
 * straight to the table (the log model takes no client writes and no data-
 * client writes; IAM only), and the loan is created only on all-pass.
 */
export const pfOriginate = defineFunction({
  name: "pf-originate",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  resourceGroupName: "data",
});
