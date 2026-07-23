import { defineStorage } from "@aws-amplify/backend";
import { processDocument } from "../functions/process-document/resource";

/**
 * Document storage.
 *
 * Uploaded documents live under:
 *   documents/{entityType}/{entityId}/{documentId}/{filename}
 * so the OCR trigger can find the Document record from the object key.
 *
 * Generated certificate PDFs live under certificates/; ACORD fillable
 * templates under templates/.
 *
 * NOTE on groups: users in a Cognito group assume that group's IAM role
 * (not the base authenticated role), so every group needs its own grant —
 * allow.authenticated alone silently locks out group members.
 */
const ALL_GROUPS = ["ADMIN", "STAFF", "PRODUCER"];

export const storage = defineStorage({
  name: "crmDocuments",
  access: (allow) => ({
    "documents/*": [
      allow.authenticated.to(["read", "write", "delete"]),
      allow.groups(ALL_GROUPS).to(["read", "write", "delete"]),
      allow.resource(processDocument).to(["read"]),
    ],
    "certificates/*": [
      allow.authenticated.to(["read", "write", "delete"]),
      allow.groups(ALL_GROUPS).to(["read", "write", "delete"]),
    ],
    "templates/*": [
      allow.authenticated.to(["read", "write", "delete"]),
      allow.groups(ALL_GROUPS).to(["read", "write", "delete"]),
    ],
  }),
  triggers: {
    onUpload: processDocument,
  },
});
