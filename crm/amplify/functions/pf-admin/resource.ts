import { defineFunction } from "@aws-amplify/backend";

/**
 * The premium-finance kill switch, and why it is a Lambda.
 *
 * The module flag lives on AgencySettings so counsel can stop originations in
 * minutes without a deploy — but an ADMIN-writable toggle on a lending product
 * without an audit trail is worse than an env var. So the flag is written ONLY
 * here: one mutation that flips the setting and logs who flipped it, when, and
 * which way, into PfComplianceLog in the same invocation. The ordinary
 * settings write path never touches this field, and the log model accepts no
 * client writes at all — the flip and its record cannot come apart.
 */
export const pfAdmin = defineFunction({
  name: "pf-admin",
  entry: "./handler.ts",
  timeoutSeconds: 20,
  resourceGroupName: "data",
});
