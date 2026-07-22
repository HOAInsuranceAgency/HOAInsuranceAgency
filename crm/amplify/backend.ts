import { defineBackend } from "@aws-amplify/backend";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { storage } from "./storage/resource";
import { processDocument } from "./functions/process-document/resource";
import { leadIntake } from "./functions/lead-intake/resource";
import {
  magicLinkDefine,
  magicLinkCreate,
  magicLinkVerify,
} from "./functions/magic-link/resource";

const backend = defineBackend({
  auth,
  data,
  storage,
  processDocument,
  leadIntake,
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
  main: "https://main.d2d4g940z91vj4.amplifyapp.com",
};
const magicLinkBaseUrl =
  BRANCH_URLS[process.env.AWS_BRANCH ?? ""] ?? "http://localhost:5173";
// Sender must be SES-verified. gim.llc is domain-verified today; switch to a
// protectmyhoa.com address once that domain is verified in SES.
const magicLinkFrom = "HOA CRM <noreply@gim.llc>";

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
