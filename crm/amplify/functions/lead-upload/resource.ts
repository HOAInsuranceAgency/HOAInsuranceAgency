import { defineFunction } from "@aws-amplify/backend";

/**
 * Public document upload for a website lead.
 *
 * Backs two API-key mutations, `requestLeadUpload` and
 * `closeLeadUploadWindow`. Both are gated on the `uploadToken` handed back by
 * `submitWebLead` — that token is the entire authorization story here, so the
 * handler checks it before touching anything and never accepts an account id
 * from the caller.
 *
 * It mints a presigned S3 PUT with its own credentials rather than opening the
 * `documents/` prefix to unauthenticated writes. The object lands at the same
 * `documents/{entityType}/{entityId}/{documentId}/{filename}` key a staff
 * upload uses, so the OCR trigger parses it and the Documents tab renders it
 * with no special case for leads.
 *
 * Not scheduled — invoked by AppSync. Short timeout: presigning is local
 * arithmetic plus one small write.
 */
export const leadUpload = defineFunction({
  name: "lead-upload",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  memoryMB: 512,
  resourceGroupName: "data",
});
