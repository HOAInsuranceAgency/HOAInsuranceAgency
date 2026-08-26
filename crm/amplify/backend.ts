import { defineBackend } from "@aws-amplify/backend";
import { Duration } from "aws-cdk-lib";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import {
  AttributeType,
  BillingMode,
  StreamViewType,
  Table,
  TableEncryption,
} from "aws-cdk-lib/aws-dynamodb";
import {
  CfnFunction,
  FunctionUrlAuthType,
  StartingPosition,
} from "aws-cdk-lib/aws-lambda";
import { DynamoEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { storage } from "./storage/resource";
import { processDocument } from "./functions/process-document/resource";
import { leadIntake } from "./functions/lead-intake/resource";
import { teamAdmin } from "./functions/team-admin/resource";
import { extractLead } from "./functions/extract-lead/resource";
import { formFiller } from "./functions/form-filler/resource";
import { certNumber } from "./functions/cert-number/resource";
import { invoiceNumber } from "./functions/invoice-number/resource";
import { renewalTasks } from "./functions/renewal-tasks/resource";
import { licenseAlerts } from "./functions/license-alerts/resource";
import { taskDigest } from "./functions/task-digest/resource";
import { opsRollup } from "./functions/ops-rollup/resource";
import { leadUpload } from "./functions/lead-upload/resource";
import { leadReply } from "./functions/lead-reply/resource";
import { uploadPortal } from "./functions/upload-portal/resource";
import { portalSweep } from "./functions/portal-sweep/resource";
import { sendInvoice } from "./functions/send-invoice/resource";
import { stripeWebhook } from "./functions/stripe-webhook/resource";
import { voidInvoice } from "./functions/void-invoice/resource";
import { pfAdmin } from "./functions/pf-admin/resource";
import { pfOriginate } from "./functions/pf-originate/resource";
import { pfAgreement } from "./functions/pf-agreement/resource";
import { pfServicing } from "./functions/pf-servicing/resource";
import { pfDefaultSweep } from "./functions/pf-default-sweep/resource";
import { pfElection } from "./functions/pf-election/resource";
import { pfAutopay } from "./functions/pf-autopay/resource";
import { resolveMailbox } from "./functions/mailbox";
import { activityLog } from "./functions/activity-log/resource";
import {
  magicLinkDefine,
  magicLinkCreate,
  magicLinkVerify,
} from "./functions/magic-link/resource";

// Exported only so `scripts/synth-check.ts` can reach the CDK app and force a
// real synth. Nothing else imports it; `ampx` uses this file for its side
// effects, as it always has.
export const backend = defineBackend({
  auth,
  data,
  storage,
  processDocument,
  leadIntake,
  teamAdmin,
  extractLead,
  formFiller,
  certNumber,
  invoiceNumber,
  renewalTasks,
  licenseAlerts,
  taskDigest,
  opsRollup,
  leadUpload,
  leadReply,
  uploadPortal,
  portalSweep,
  sendInvoice,
  stripeWebhook,
  voidInvoice,
  pfAdmin,
  pfOriginate,
  pfAgreement,
  pfServicing,
  pfDefaultSweep,
  pfElection,
  pfAutopay,
  activityLog,
  magicLinkDefine,
  magicLinkCreate,
  magicLinkVerify,
});

// The OCR function drives async Textract jobs over uploaded documents.
backend.processDocument.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ["textract:StartDocumentAnalysis", "textract:GetDocumentAnalysis"],
    resources: ["*"],
  })
);

// The extraction resolver re-invokes itself asynchronously (the actual
// Claude call outlives AppSync's 30s resolver limit). Wildcard resource:
// a self-referencing ARN would create a circular CFN dependency between
// the function and its role.
backend.extractLead.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ["lambda:InvokeFunction"],
    resources: ["*"],
  })
);

// ── Certificate numbering counter ────────────────────────────────────
// A standalone DynamoDB table (partition key = year) holding one atomic
// counter per year. reserveCertificateNumber does a single UpdateItem ADD,
// so numbers are unique and gap-free even under concurrent COI issuance.
const certStack = backend.createStack("CertNumberStack");
const certSeqTable = new Table(certStack, "CertificateSequence", {
  partitionKey: { name: "year", type: AttributeType.STRING },
  billingMode: BillingMode.PAY_PER_REQUEST,
  encryption: TableEncryption.AWS_MANAGED,
  // The numbering ledger — keep it recoverable.
  pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
});
certSeqTable.grantReadWriteData(backend.certNumber.resources.lambda);
backend.certNumber.addEnvironment("SEQ_TABLE", certSeqTable.tableName);
backend.certNumber.addEnvironment("CERT_PREFIX", "HOA");
// Seed offsets for numbering that predates this system: 10 certificates were
// issued in 2026 (HOA-2026-00001 … HOA-2026-00010), so the counter starts at
// 10 and the first system-issued number is HOA-2026-00011. Once the 2026 row
// exists this offset is ignored (if_not_exists), so it's safe to leave.
backend.certNumber.addEnvironment(
  "CERT_SEQ_BASES",
  JSON.stringify({ "2026": 10 })
);

// The invoice counter. Its own stack and its own table rather than a `kind`
// column on the certificate one: generalising that table means renaming its
// construct, which changes the logical id and REPLACES it — resetting the
// certificate counter and re-issuing numbers already printed on COIs sitting in
// carriers' files. Forty duplicated lines is the cheaper mistake.
const invoiceStack = backend.createStack("InvoiceNumberStack");
const invoiceSeqTable = new Table(invoiceStack, "InvoiceSequence", {
  partitionKey: { name: "year", type: AttributeType.STRING },
  billingMode: BillingMode.PAY_PER_REQUEST,
  encryption: TableEncryption.AWS_MANAGED,
  // The numbering ledger — keep it recoverable.
  pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
});
invoiceSeqTable.grantReadWriteData(backend.invoiceNumber.resources.lambda);
backend.invoiceNumber.addEnvironment("SEQ_TABLE", invoiceSeqTable.tableName);
backend.invoiceNumber.addEnvironment("INVOICE_PREFIX", "INV");

// ── Activity log: DynamoDB Streams → Activity rows ───────────────────
//
// Every model whose changes belong in an account's timeline. Adding one is a
// line here plus `lastWriteBy` on the model.
//
// NOT streamed: Activity itself (it would loop, and with no mapping it
// cannot), plus Carrier, AppetiteGuide, MarketingTask, UserProfile, License
// and ProducerLicense — none of them hangs off an account, and the tab is
// account-scoped. Adding any of them later is one entry each plus somewhere
// to show it.
const STREAMED_MODELS = [
  "Account",
  "Contact",
  "PriorCarrier",
  "Building",
  "Blanket",
  "GlApplication",
  "GlClassCode",
  "DoApplication",
  "DoCoveragePart",
  "Loss",
  "Quote",
  "Policy",
  "Certificate",
  "Document",
  // An invoice is a demand for money and its lifecycle is the part worth
  // attributing: who sent it, who marked it paid, who voided it. Its `accountId`
  // is what `resolveEntityId` files it under, so it needs nothing else.
  //
  // `InvoiceLine` is deliberately NOT here. It carries no `accountId`, so the
  // stream would resolve nothing and every line change would be dropped in
  // silence — the same failure the note on `Account` in diff.ts describes.
  // Streaming lines means giving them an accountId first.
  "Invoice",
] as const;

for (const model of STREAMED_MODELS) {
  const table = backend.data.resources.tables[model];

  // Set explicitly rather than relied upon. Amplify enables a stream for its
  // subscriptions, but the VIEW TYPE is what matters here and is not ours to
  // assume: OLD_IMAGE is required for the diff and is the *only* thing a
  // DELETE record carries. Asserting it costs one line and removes the
  // question — a stream that turned out to be NEW_IMAGE would produce an
  // activity log where every update looked like a creation and every delete
  // was invisible.
  //
  // Through the wrapper, NOT `table.node.defaultChild`. An Amplify data table
  // is a `Custom::AmplifyDynamoDBTable` custom resource, not a CDK L2 Table,
  // so it has no CfnTable default child — reaching for one yields undefined
  // and fails synth with "Cannot set properties of undefined". `tsc` cannot
  // see that, because the cast asserts the type it wanted; the only thing
  // that catches it is a synth, which is why `npm run synth:check` exists.
  backend.data.resources.cfnResources.amplifyDynamoDbTables[model].streamSpecification =
    { streamViewType: StreamViewType.NEW_AND_OLD_IMAGES };

  backend.activityLog.resources.lambda.addEventSource(
    new DynamoEventSource(table, {
      startingPosition: StartingPosition.LATEST,
      // A form save that writes three rows should be one invocation, not
      // three. Five seconds is short enough that the tab feels live.
      batchSize: 25,
      maxBatchingWindow: Duration.seconds(5),
      // A poison record must not replay until the stream's 24-hour retention
      // drops it. The handler already swallows per-record failures; these are
      // the backstop for anything it cannot.
      retryAttempts: 2,
      bisectBatchOnError: false,
      reportBatchItemFailures: false,
    })
  );
}

// ── Auth behavior ────────────────────────────────────────────────────
const { cfnUserPool, cfnUserPoolClient } = backend.auth.resources.cfnResources;

// Magic-link only: the custom auth flow is the sole sign-in path.
cfnUserPool.userPoolTier = "ESSENTIALS";
cfnUserPoolClient.explicitAuthFlows = [
  "ALLOW_CUSTOM_AUTH",
  "ALLOW_REFRESH_TOKEN_AUTH",
];

// Stay signed in for 7 days (refresh token lifetime).
cfnUserPoolClient.refreshTokenValidity = 7;
cfnUserPoolClient.tokenValidityUnits = { refreshToken: "days" };

// ── Magic link plumbing ──────────────────────────────────────────────
// Signing secret shared by the create/verify triggers (generated once per
// backend, never leaves Secrets Manager).
const magicLinkStack = backend.createStack("MagicLinkStack");
const magicLinkSecret = new Secret(magicLinkStack, "MagicLinkSigningSecret", {
  generateSecretString: { passwordLength: 64, excludePunctuation: true },
});
magicLinkSecret.grantRead(backend.magicLinkCreate.resources.lambda);
magicLinkSecret.grantRead(backend.magicLinkVerify.resources.lambda);

// Where the emailed link points, per branch (custom domains: update here).
const BRANCH_URLS: Record<string, string> = {
  staging: "https://staging.d2d4g940z91vj4.amplifyapp.com",
  main: "https://app.protectmyhoa.com",
};
const magicLinkBaseUrl =
  BRANCH_URLS[process.env.AWS_BRANCH ?? ""] ?? "http://localhost:5173";

/**
 * The marketing site's host, per branch. Where a lead's upload link points.
 *
 * A second map rather than a reuse of the one above: the portal page is a static
 * route on the *website* app, a different Amplify app on a different domain, and
 * the CRM is behind a login. A staging link has to point at the staging site or
 * the page cannot resolve its own token — the API key is baked in per build.
 *
 * Literals, not `AGENCY.site`, because this file cannot import `shared/` (see
 * the note under the mailbox block). Both `tsc` and `synth:check` pass on that
 * import and only a real pipeline deploy fails, so it is not a mistake worth
 * being clever near.
 */
const SITE_BRANCH_URLS: Record<string, string> = {
  staging: "https://staging.dx1256wpowwzz.amplifyapp.com",
  main: "https://www.protectmyhoa.com",
};
const siteBaseUrl =
  SITE_BRANCH_URLS[process.env.AWS_BRANCH ?? ""] ?? "http://localhost:4321";
// Sender must be SES-verified (protectmyhoa.com domain, DKIM verified).
const magicLinkFrom = "HOA Insurance Agency <noreply@protectmyhoa.com>";

/**
 * The agency-side mailbox on outbound lead mail: the From, the Reply-To, and
 * the team's BCC.
 *
 * Per branch, because staging sends real email. A test lead on staging would
 * otherwise put a From of sales@ in front of the visitor, land a BCC in the
 * inbox the team actually works out of, and route any reply there too. None of
 * that is wrong in production and all of it is noise anywhere else.
 *
 * The map and its safe default live in `functions/mailbox.ts` so the direction
 * of that default is unit tested rather than asserted here. `internal` is the
 * general inbox: a digest or a licence deadline is not a sales conversation.
 */
const branch = process.env.AWS_BRANCH;
const leadReplyMailbox = resolveMailbox("lead", branch);
const internalMailbox = resolveMailbox("internal", branch);

backend.magicLinkCreate.addEnvironment("MAGIC_LINK_SECRET_ARN", magicLinkSecret.secretArn);
backend.magicLinkVerify.addEnvironment("MAGIC_LINK_SECRET_ARN", magicLinkSecret.secretArn);
backend.magicLinkCreate.addEnvironment("MAGIC_LINK_BASE_URL", magicLinkBaseUrl);
backend.magicLinkCreate.addEnvironment("MAGIC_LINK_FROM", magicLinkFrom);

backend.magicLinkCreate.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ["ses:SendEmail"],
    resources: ["*"],
  })
);

// ── Team admin (in-app invites) ──────────────────────────────────────
backend.teamAdmin.addEnvironment(
  "USER_POOL_ID",
  backend.auth.resources.userPool.userPoolId
);
backend.teamAdmin.addEnvironment("PORTAL_URL", magicLinkBaseUrl);
backend.teamAdmin.addEnvironment("INVITE_FROM", magicLinkFrom);
backend.teamAdmin.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: [
      "cognito-idp:AdminCreateUser",
      "cognito-idp:AdminAddUserToGroup",
      "cognito-idp:AdminListGroupsForUser",
      "cognito-idp:ListUsers",
    ],
    resources: [backend.auth.resources.userPool.userPoolArn],
  })
);
backend.teamAdmin.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ["ses:SendEmail"],
    resources: ["*"],
  })
);

// ── License expiry alerts ────────────────────────────────────────────
// Same verified sender as everything else we send.
//
// The RECIPIENT is deliberately not here. It comes from `shared/agency.ts`,
// and this file cannot import that: Amplify's CDK assembly builder loads
// `backend.ts` through a TS loader scoped to `amplify/`, so a path reaching
// outside resolves to a module with no exports and the deploy dies with
// "does not provide an export named 'AGENCY'". Handlers are different — they
// are bundled by esbuild, which is why `renewal-tasks/handler.ts` can import
// `src/lib/pagination` — so the address is read there instead. `tsc` and
// `npm run synth:check` both pass on the import that fails; only a real
// pipeline deploy catches it.
// ── Lead text alerts ─────────────────────────────────────────────────
// The intake handler texts every UserProfile with leadTextAlerts on. The
// link in the message is this branch's portal, so it opens the lead the
// recipient is being told about rather than the wrong environment's.
//
// `sns:Publish` on `*` because SMS-to-a-phone-number has no topic ARN to
// scope to — the resource being published to is the number itself.
//
// ⚠️ Provisioning is NOT in this stack. Amazon SNS will not deliver to US
// numbers until the account is out of the SMS sandbox AND has a registered
// origination identity (10DLC for a long code, or a toll-free number).
// Until then Publish succeeds and the message is dropped downstream, which
// looks identical to working. See README.
backend.leadIntake.addEnvironment("CRM_BASE_URL", magicLinkBaseUrl);
backend.leadIntake.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ["sns:Publish"],
    resources: ["*"],
  })
);

backend.licenseAlerts.addEnvironment("LICENSE_ALERT_FROM", magicLinkFrom);
backend.licenseAlerts.addEnvironment("AGENCY_MAILBOX", internalMailbox);
backend.licenseAlerts.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ["ses:SendEmail"],
    resources: ["*"],
  })
);

// Same verified sender as every other outbound mail. `CRM_BASE_URL` is what
// turns the digest into a worklist rather than a notification — without it
// the rows still render, just without deep links into the CRM.
backend.taskDigest.addEnvironment("TASK_DIGEST_FROM", magicLinkFrom);
backend.taskDigest.addEnvironment("AGENCY_MAILBOX", internalMailbox);
backend.taskDigest.addEnvironment("CRM_BASE_URL", magicLinkBaseUrl);

/**
 * The owner's daily operations rollup.
 *
 * Same verified no-reply sender as everything else — a dedicated identity
 * would mean a new SES verified domain or address, visible in the console with
 * publicly resolvable DKIM records, which is more discoverable than sharing
 * the sender everything already uses.
 *
 * `owner` rather than `internal`: the recipient is one person, and `internal`
 * is the inbox the whole team works out of. There is deliberately NO fallback
 * inside the handler if this variable goes missing — see the note there.
 */
backend.opsRollup.addEnvironment("OPS_ROLLUP_FROM", magicLinkFrom);
backend.opsRollup.addEnvironment("OPS_ROLLUP_TO", resolveMailbox("owner", branch));
backend.opsRollup.addEnvironment("CRM_BASE_URL", magicLinkBaseUrl);

// Invoices come from the general mailbox rather than sales: a bill is not a
// sales conversation, and a reply to one should land where the people who
// reconcile payments are looking.
backend.sendInvoice.addEnvironment("AGENCY_MAILBOX", internalMailbox);
backend.sendInvoice.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    /**
     * `SendRawEmail` as well, and this one is not optional.
     *
     * Every other sender here uses SES's `Simple` content and needs only
     * `ses:SendEmail`. This one switched to `Raw` to carry the PDF attachment,
     * which Simple content cannot do — and raw content is authorized by
     * `ses:SendRawEmail` even when sent through the v2 SendEmail call. Without
     * it every invoice send fails with AccessDenied at the SES call, after the
     * link has been minted and the PDF rendered.
     *
     * Nothing local catches this: the tests, the typecheck and the CDK synth
     * all pass. It took invoking the deployed function to see it.
     */
    actions: ["ses:SendEmail", "ses:SendRawEmail"],
    resources: ["*"],
  })
);

/**
 * Stripe.
 *
 * `send-invoice` mints the payment link; `stripe-webhook` hears back when the
 * money moves. Both need the secret key, so both declare it — `secret()`
 * resolves per branch, which means test keys on staging and live keys on main
 * without a conditional anywhere in this file.
 *
 * The webhook is a Function URL with auth NONE. That is not an oversight:
 * Stripe cannot sign SigV4, so the request is authenticated by the signature
 * over its own payload, which the handler verifies before parsing anything.
 * The URL is printed in the deploy output; it goes in Stripe's dashboard, and
 * the signing secret they show once comes back as STRIPE_WEBHOOK_SECRET.
 */
/**
 * The webhook writes payment state with a conditional UpdateItem rather than
 * through the data client, which cannot express one — see stripe-webhook/
 * persist.ts. That needs the table by name and direct write access to it.
 */
const invoiceTable = backend.data.resources.tables.Invoice;
backend.stripeWebhook.addEnvironment("INVOICE_TABLE", invoiceTable.tableName);
invoiceTable.grantReadWriteData(backend.stripeWebhook.resources.lambda);

/**
 * Voiding needs the same direct access, for the same reason: its write is
 * conditional on what it read — a void must lose to a payment that lands in
 * the window where the Stripe link is being deactivated — and the data client
 * cannot express a condition. See void-invoice/handler.ts.
 */
backend.voidInvoice.addEnvironment("INVOICE_TABLE", invoiceTable.tableName);
invoiceTable.grantReadWriteData(backend.voidInvoice.resources.lambda);

/**
 * Premium finance admin: the module flag and its audit row are written by one
 * Lambda over direct table access — see pf-admin/resource.ts for why the flip
 * and its record must be inseparable.
 */
const pfLogTable = backend.data.resources.tables.PfComplianceLog;
backend.pfAdmin.addEnvironment(
  "AGENCY_SETTINGS_TABLE",
  backend.data.resources.tables.AgencySettings.tableName
);
backend.pfAdmin.addEnvironment("PF_COMPLIANCE_LOG_TABLE", pfLogTable.tableName);
backend.data.resources.tables.AgencySettings.grantReadWriteData(
  backend.pfAdmin.resources.lambda
);
pfLogTable.grantReadWriteData(backend.pfAdmin.resources.lambda);

// Origination writes its decision rows straight to the log table too; model
// reads and the PfLoan create go through the data client via allow.resource.
backend.pfOriginate.addEnvironment("PF_COMPLIANCE_LOG_TABLE", pfLogTable.tableName);
pfLogTable.grantReadWriteData(backend.pfOriginate.resources.lambda);
// The loan create is a cross-table transaction with a ConditionCheck on the
// module flag, so origination needs both tables directly.
backend.pfOriginate.addEnvironment(
  "AGENCY_SETTINGS_TABLE",
  backend.data.resources.tables.AgencySettings.tableName
);
backend.pfOriginate.addEnvironment(
  "PF_LOAN_TABLE",
  backend.data.resources.tables.PfLoan.tableName
);
backend.data.resources.tables.AgencySettings.grantReadData(
  backend.pfOriginate.resources.lambda
);
backend.data.resources.tables.PfLoan.grantReadWriteData(
  backend.pfOriginate.resources.lambda
);

// Servicing and the default sweep write their decision rows to the log too.
for (const fn of [backend.pfServicing, backend.pfDefaultSweep]) {
  fn.addEnvironment("PF_COMPLIANCE_LOG_TABLE", pfLogTable.tableName);
  pfLogTable.grantReadWriteData(fn.resources.lambda);
}

/**
 * Servicing's idempotency writes go straight to the tables: a deterministic
 * ledger id refuses a duplicate posting atomically, and status transitions
 * are conditional on the status they leave — the data client can express
 * neither. Same reasoning as stripe-webhook's persist.ts.
 */
for (const [name, model] of [
  ["PF_LOAN_TABLE", "PfLoan"],
  ["PF_LOAN_PAYMENT_TABLE", "PfLoanPayment"],
  // Cancellation and its CANCELLATION_REQUEST notice are one transaction.
  ["PF_NOTICE_TABLE", "PfNotice"],
] as const) {
  const table = backend.data.resources.tables[model];
  backend.pfServicing.addEnvironment(name, table.tableName);
  table.grantReadWriteData(backend.pfServicing.resources.lambda);
}
// The sweep's default-mark is conditional (still ACTIVE, same due date), so
// it too writes the loan table directly.
backend.pfDefaultSweep.addEnvironment(
  "PF_LOAN_TABLE",
  backend.data.resources.tables.PfLoan.tableName
);
backend.data.resources.tables.PfLoan.grantReadWriteData(
  backend.pfDefaultSweep.resources.lambda
);

// The agreement renderer writes its PDFs under generated/pf/ — outside
// documents/, so the OCR upload trigger never re-reads the app's own output.
backend.pfAgreement.addEnvironment(
  "DOCUMENTS_BUCKET",
  backend.storage.resources.bucket.bucketName
);
backend.storage.resources.bucket.grantPut(
  backend.pfAgreement.resources.lambda,
  "generated/pf/*"
);

/**
 * And the send, for one write: storing a freshly minted payment link
 * conditionally on the link it replaced, so two overlapping sends cannot leave
 * the loser's link live and tracked by nothing. Everything else in the send
 * still goes through the data client.
 */
backend.sendInvoice.addEnvironment("INVOICE_TABLE", invoiceTable.tableName);
invoiceTable.grantReadWriteData(backend.sendInvoice.resources.lambda);
/**
 * W7: the email's financing fork. The send mints the election token onto the
 * QUOTED loan — conditionally, direct to the table — and links to the public
 * site's finance page.
 */
backend.sendInvoice.addEnvironment(
  "PF_LOAN_TABLE",
  backend.data.resources.tables.PfLoan.tableName
);
backend.data.resources.tables.PfLoan.grantReadWriteData(
  backend.sendInvoice.resources.lambda
);
backend.sendInvoice.addEnvironment("SITE_URL", siteBaseUrl);
/**
 * W8: origination happens at send, through the shared core — so the send
 * writes decision rows and its loan create transacts with the kill switch.
 */
backend.sendInvoice.addEnvironment("PF_COMPLIANCE_LOG_TABLE", pfLogTable.tableName);
pfLogTable.grantWriteData(backend.sendInvoice.resources.lambda);
backend.sendInvoice.addEnvironment(
  "AGENCY_SETTINGS_TABLE",
  backend.data.resources.tables.AgencySettings.tableName
);
backend.data.resources.tables.AgencySettings.grantReadData(
  backend.sendInvoice.resources.lambda
);

/**
 * Reporting the split to corporate finance, when Stripe confirms a payment.
 *
 * The email names the association and the carrier, which the invoice row holds
 * only as ids — so three more tables, read-only, by primary key. The webhook
 * has no data client to ask instead; see stripe-webhook/persist.ts.
 *
 * `internalMailbox` is the From rather than the accounting address: the mail
 * has to come from a domain SES has verified, and getgim.com is not one.
 */
const accountingMailbox = resolveMailbox("accounting", branch);
backend.stripeWebhook.addEnvironment("ACCOUNTING_MAILBOX", accountingMailbox);
backend.stripeWebhook.addEnvironment("AGENCY_MAILBOX", internalMailbox);
for (const [name, model] of [
  ["ACCOUNT_TABLE", "Account"],
  ["POLICY_TABLE", "Policy"],
  ["CARRIER_TABLE", "Carrier"],
] as const) {
  const table = backend.data.resources.tables[model];
  backend.stripeWebhook.addEnvironment(name, table.tableName);
  table.grantReadData(backend.stripeWebhook.resources.lambda);
}
backend.stripeWebhook.resources.lambda.addToRolePolicy(
  new PolicyStatement({ actions: ["ses:SendEmail"], resources: ["*"] })
);
// Paying in full supersedes any QUOTED finance loan on the policy — the
// webhook cancels those conditionally and logs the supersession.
backend.stripeWebhook.addEnvironment(
  "PF_LOAN_TABLE",
  backend.data.resources.tables.PfLoan.tableName
);
backend.data.resources.tables.PfLoan.grantReadWriteData(
  backend.stripeWebhook.resources.lambda
);
backend.stripeWebhook.addEnvironment(
  "PF_COMPLIANCE_LOG_TABLE",
  backend.data.resources.tables.PfComplianceLog.tableName
);
backend.data.resources.tables.PfComplianceLog.grantWriteData(
  backend.stripeWebhook.resources.lambda
);

// W7: the webhook consults the kill switch at settle time — not to refuse
// money, but to record and alarm when a pre-disable election completes
// under a disabled module.
backend.stripeWebhook.addEnvironment(
  "AGENCY_SETTINGS_TABLE",
  backend.data.resources.tables.AgencySettings.tableName
);
backend.data.resources.tables.AgencySettings.grantReadData(
  backend.stripeWebhook.resources.lambda
);

/**
 * W7: autopay debits post to the ledger through the webhook, so the webhook
 * gets the payment table too — the same shared posting core pf-servicing
 * uses, the same direct-write reasoning.
 */
backend.stripeWebhook.addEnvironment(
  "PF_LOAN_PAYMENT_TABLE",
  backend.data.resources.tables.PfLoanPayment.tableName
);
backend.data.resources.tables.PfLoanPayment.grantReadWriteData(
  backend.stripeWebhook.resources.lambda
);

/**
 * W7: the election endpoint. Its writes are all direct: the pay-in-full void
 * (void-invoice's own code, imported — INVOICE_TABLE), the electedAt stamp
 * (PF_LOAN_TABLE, conditional), and the compliance row. SITE_URL is where
 * Checkout returns the customer — the public website's finance page.
 */
backend.pfElection.addEnvironment("INVOICE_TABLE", invoiceTable.tableName);
invoiceTable.grantReadWriteData(backend.pfElection.resources.lambda);
backend.pfElection.addEnvironment(
  "PF_LOAN_TABLE",
  backend.data.resources.tables.PfLoan.tableName
);
backend.data.resources.tables.PfLoan.grantReadWriteData(
  backend.pfElection.resources.lambda
);
backend.pfElection.addEnvironment("PF_COMPLIANCE_LOG_TABLE", pfLogTable.tableName);
pfLogTable.grantWriteData(backend.pfElection.resources.lambda);
backend.pfElection.addEnvironment("SITE_URL", siteBaseUrl);
// The election stamp transacts with a ConditionCheck on the kill switch —
// pf-originate's pattern; grantReadData carries ConditionCheckItem.
backend.pfElection.addEnvironment(
  "AGENCY_SETTINGS_TABLE",
  backend.data.resources.tables.AgencySettings.tableName
);
backend.data.resources.tables.AgencySettings.grantReadData(
  backend.pfElection.resources.lambda
);

/**
 * W7: the autopay cron scans the loan table itself (no data client — its
 * pending-marker write is conditional) and logs every attempt.
 */
backend.pfAutopay.addEnvironment(
  "PF_LOAN_TABLE",
  backend.data.resources.tables.PfLoan.tableName
);
backend.data.resources.tables.PfLoan.grantReadWriteData(
  backend.pfAutopay.resources.lambda
);
backend.pfAutopay.addEnvironment("PF_COMPLIANCE_LOG_TABLE", pfLogTable.tableName);
pfLogTable.grantWriteData(backend.pfAutopay.resources.lambda);
// The autopay heal path posts an adopted succeeded debit itself, so it
// needs the ledger table the shared core writes.
backend.pfAutopay.addEnvironment(
  "PF_LOAN_PAYMENT_TABLE",
  backend.data.resources.tables.PfLoanPayment.tableName
);
backend.data.resources.tables.PfLoanPayment.grantReadWriteData(
  backend.pfAutopay.resources.lambda
);

/**
 * W7: the sweep's stale-marker alarm goes to the mailbox a person reads —
 * a debit nothing has cleared in ten days freezes its loan, and a console
 * line is not an alarm.
 */
backend.pfDefaultSweep.addEnvironment("ACCOUNTING_MAILBOX", accountingMailbox);
backend.pfDefaultSweep.addEnvironment("AGENCY_MAILBOX", internalMailbox);
backend.pfDefaultSweep.resources.lambda.addToRolePolicy(
  new PolicyStatement({ actions: ["ses:SendEmail"], resources: ["*"] })
);

const stripeWebhookUrl = backend.stripeWebhook.resources.lambda.addFunctionUrl({
  authType: FunctionUrlAuthType.NONE,
});
backend.addOutput({
  custom: { stripeWebhookUrl: stripeWebhookUrl.url },
});
backend.taskDigest.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ["ses:SendEmail"],
    resources: ["*"],
  })
);
backend.opsRollup.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ["ses:SendEmail"],
    resources: ["*"],
  })
);

// ── Website lead: public upload + auto-reply ─────────────────────────
//
// `lead-upload` presigns a PUT into the documents bucket with its own
// credentials. That is what lets an unauthenticated visitor write a file
// without `documents/*` being opened to public writes — the storage access
// rules govern Amplify's client-side auth, while a presigned URL is plain
// SigV4 against S3, so the grant below is the only thing that authorizes it.
backend.leadUpload.addEnvironment(
  "DOCUMENTS_BUCKET",
  backend.storage.resources.bucket.bucketName
);
backend.storage.resources.bucket.grantPut(
  backend.leadUpload.resources.lambda,
  "documents/*"
);

/**
 * The two public upload handlers take their file-count slot with a conditional
 * DynamoDB UpdateItem rather than through the data client, which cannot express
 * one — see functions/uploadQuota.ts. That needs the table by name and direct
 * write access to it, which the API-wide `allow.resource()` grant does not give.
 */
const leadReplyTable = backend.data.resources.tables.LeadReply;
const uploadPortalTable = backend.data.resources.tables.UploadPortal;
backend.leadUpload.addEnvironment("LEAD_REPLY_TABLE", leadReplyTable.tableName);
leadReplyTable.grantReadWriteData(backend.leadUpload.resources.lambda);
backend.uploadPortal.addEnvironment(
  "UPLOAD_PORTAL_TABLE",
  uploadPortalTable.tableName
);
uploadPortalTable.grantReadWriteData(backend.uploadPortal.resources.lambda);

/**
 * One sweep at a time, each.
 *
 * Both run on a cron with a timeout far longer than their interval, so a slow
 * pass overlaps the next tick. `lead-reply` claims a row by flipping it to
 * SENDING before generating, but that write carries no condition on the current
 * status — two overlapping passes both read WAITING, both claim, and the lead
 * gets the same email twice. Amplify's data client cannot express a conditional
 * update, so the overlap is removed instead of the race being lost.
 *
 * A throttled tick is harmless: the schedule fires again a minute later, and
 * anything still due is still due.
 */
for (const fn of [backend.leadReply, backend.portalSweep]) {
  (fn.resources.lambda.node.defaultChild as CfnFunction).reservedConcurrentExecutions = 1;
}

// The document portal presigns the same way, and into the same prefix, for the
// same reason. Its own grant rather than a shared role: the two functions have
// different lifetimes and one should not inherit the other's reach.
backend.uploadPortal.addEnvironment(
  "DOCUMENTS_BUCKET",
  backend.storage.resources.bucket.bucketName
);
backend.storage.resources.bucket.grantPut(
  backend.uploadPortal.resources.lambda,
  "documents/*"
);

// The sweep sends the reply and starts extraction for public leads —
// `startLeadExtraction` is authenticated-only, so no visitor can reach it.
backend.leadReply.addEnvironment("AGENCY_MAILBOX", leadReplyMailbox);
// Where a lead's document-upload link points: the marketing site, not the CRM.
backend.leadReply.addEnvironment("SITE_BASE_URL", siteBaseUrl);

/**
 * The document-upload notification sweep.
 *
 * Same three grants as `lead-reply`, because it does the same three things: it
 * emails the agency mailbox, it links into the CRM, and it kicks off extraction
 * for documents that arrived after the reply window closed — which is the only
 * path that reads them, since `startLeadExtraction` is authenticated-only and no
 * visitor can reach it.
 */
backend.portalSweep.addEnvironment("AGENCY_MAILBOX", leadReplyMailbox);
/**
 * The sweep HEADs each new document before calling it received: a Document row
 * is created when an upload URL is *requested*, so an abandoned upload would
 * otherwise be reported as an arrival.
 */
backend.portalSweep.addEnvironment(
  "DOCUMENTS_BUCKET",
  backend.storage.resources.bucket.bucketName
);
backend.storage.resources.bucket.grantRead(
  backend.portalSweep.resources.lambda,
  "documents/*"
);
backend.portalSweep.addEnvironment("CRM_BASE_URL", magicLinkBaseUrl);
backend.portalSweep.addEnvironment(
  "EXTRACT_LEAD_FUNCTION",
  backend.extractLead.resources.lambda.functionName
);
backend.extractLead.resources.lambda.grantInvoke(
  backend.portalSweep.resources.lambda
);
backend.portalSweep.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ["ses:SendEmail"],
    resources: ["*"],
  })
);
backend.leadReply.addEnvironment(
  "EXTRACT_LEAD_FUNCTION",
  backend.extractLead.resources.lambda.functionName
);
backend.extractLead.resources.lambda.grantInvoke(
  backend.leadReply.resources.lambda
);
backend.leadReply.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ["ses:SendEmail"],
    resources: ["*"],
  })
);
