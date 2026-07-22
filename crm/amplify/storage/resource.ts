import { defineStorage } from "@aws-amplify/backend";
import { processDocument } from "../functions/process-document/resource";

/**
 * Document storage.
 *
 * Uploaded documents live under:
 *   documents/{entityType}/{entityId}/{documentId}/{filename}
 * so the OCR trigger can find the Document record from the object key.
 *
 * Generated certificate PDFs live under certificates/.
 */
export const storage = defineStorage({
  name: "crmDocuments",
  access: (allow) => ({
    "documents/*": [
      allow.authenticated.to(["read", "write", "delete"]),
      allow.resource(processDocument).to(["read"]),
    ],
    "certificates/*": [allow.authenticated.to(["read", "write", "delete"])],
  }),
  triggers: {
    onUpload: processDocument,
  },
});
