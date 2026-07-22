import { defineFunction } from "@aws-amplify/backend";

/**
 * S3 onUpload trigger: runs Textract over uploaded documents and writes the
 * extracted text/tables back onto the Document record.
 *
 * Uses the async Textract API (required for multi-page PDFs) and polls for
 * completion in-function — simple and reliable at agency document volumes.
 */
export const processDocument = defineFunction({
  name: "process-document",
  entry: "./handler.ts",
  timeoutSeconds: 900,
  memoryMB: 1024,
});
