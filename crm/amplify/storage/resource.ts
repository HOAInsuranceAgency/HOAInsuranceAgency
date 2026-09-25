import { defineStorage } from "@aws-amplify/backend";
import { processDocument } from "../functions/process-document/resource";

// Browsers use crmFile, which checks account assignment before signing an S3
// operation. Giving Cognito roles prefix-wide access would bypass those checks.
export const storage = defineStorage({
  name: "crmDocuments",
  access: allow => ({ "documents/*": [allow.resource(processDocument).to(["read"])] }),
  triggers: { onUpload: processDocument },
});
