import { defineFunction, secret } from "@aws-amplify/backend";

/**
 * AI gap-filling for generated ACORD forms.
 *
 * Runs synchronously behind the `suggestFormFields` mutation: the browser is
 * holding a half-filled PDF and waiting, so this has to answer inside
 * AppSync's 30s resolver limit rather than self-invoking like `extract-lead`.
 * The account bundle is prompt-cached, which is what keeps a six-document run
 * over one account inside that budget.
 *
 * ANTHROPIC_API_KEY is the same Amplify secret `extract-lead` uses.
 */
export const formFiller = defineFunction({
  name: "form-filler",
  entry: "./handler.ts",
  timeoutSeconds: 29,
  memoryMB: 1024,
  environment: {
    ANTHROPIC_API_KEY: secret("ANTHROPIC_API_KEY"),
  },
});
