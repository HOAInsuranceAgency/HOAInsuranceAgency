import { defineBackend } from "@aws-amplify/backend";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { storage } from "./storage/resource";
import { processDocument } from "./functions/process-document/resource";
import { leadIntake } from "./functions/lead-intake/resource";

const backend = defineBackend({
  auth,
  data,
  storage,
  processDocument,
  leadIntake,
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

// Passwordless sign-in (emailed one-time code) alongside password.
// Requires the Essentials tier + the USER_AUTH flow on the app client.
cfnUserPool.userPoolTier = "ESSENTIALS";
cfnUserPool.addPropertyOverride("Policies.SignInPolicy.AllowedFirstAuthFactors", [
  "PASSWORD",
  "EMAIL_OTP",
]);
cfnUserPoolClient.explicitAuthFlows = [
  "ALLOW_USER_AUTH",
  "ALLOW_USER_SRP_AUTH",
  "ALLOW_REFRESH_TOKEN_AUTH",
];

// Stay signed in for 7 days (refresh token lifetime).
cfnUserPoolClient.refreshTokenValidity = 7;
cfnUserPoolClient.tokenValidityUnits = { refreshToken: "days" };
