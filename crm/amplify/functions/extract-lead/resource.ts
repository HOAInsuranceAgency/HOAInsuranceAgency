import { defineFunction, secret } from "@aws-amplify/backend";

/**
 * AI document extraction: reads all OCR-complete documents on an account and
 * has Claude extract every datapoint the CRM tracks, with per-field
 * confidence + evidence. Runs async (self-invoke) because extraction over a
 * thick document set exceeds AppSync's 30s resolver limit; results land on
 * Account.aiExtraction for the review-and-apply UI.
 *
 * ANTHROPIC_API_KEY is an Amplify secret — set it per branch in the Amplify
 * console (Hosting → Secrets) and via `ampx sandbox secret set` locally.
 */
export const extractLead = defineFunction({
  name: "extract-lead",
  entry: "./handler.ts",
  timeoutSeconds: 900,
  memoryMB: 1024,
  environment: {
    ANTHROPIC_API_KEY: secret("ANTHROPIC_API_KEY"),
  },
});
