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
