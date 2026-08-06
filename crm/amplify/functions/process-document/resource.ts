import { defineFunction, secret } from "@aws-amplify/backend";

/**
 * S3 onUpload trigger: runs Textract over uploaded documents and writes the
 * extracted text/tables back onto the Document record, then asks Claude for a
 * readable name to replace `scan_0043.pdf` with.
 *
 * Uses the async Textract API (required for multi-page PDFs) and polls for
 * completion in-function — simple and reliable at agency document volumes.
 *
 * ANTHROPIC_API_KEY is the same Amplify secret `extract-lead` and
 * `form-filler` use; naming is a best-effort tail step, so a branch where the
 * secret is unset still OCRs, it just keeps the uploaded filename.
 */
export const processDocument = defineFunction({
  name: "process-document",
  entry: "./handler.ts",
  timeoutSeconds: 900,
  memoryMB: 1024,
  environment: {
    ANTHROPIC_API_KEY: secret("ANTHROPIC_API_KEY"),
  },
});
