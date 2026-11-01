import { providerBranch } from "../../migration-config";
import { defineFunction, secret } from "@aws-amplify/backend";
import { honeycombEnvironmentForBranch } from "./environment";

// Each release branch resolves its own credentials. Previews and sandboxes stay disabled.
const environment = honeycombEnvironmentForBranch(providerBranch);
const enabled = environment !== "disabled";
const runtimeEnvironment = {
  HONEYCOMB_ENABLED: String(enabled),
  HONEYCOMB_ENVIRONMENT: environment,
};
export const honeycombWorker = defineFunction({
  name: "honeycomb-estimate-worker", entry: "./worker.ts", resourceGroupName: "data",
  timeoutSeconds: 90, memoryMB: 512,
  environment: {
    ...runtimeEnvironment,
    ...(enabled ? {
      HONEYCOMB_API_USER: secret("HONEYCOMB_API_USER"),
      HONEYCOMB_PRODUCER_ID: secret("HONEYCOMB_PRODUCER_ID"),
      HONEYCOMB_API_SECRET_KEY: secret("HONEYCOMB_API_SECRET_KEY"),
      HONEYCOMB_API_BASE_URL: secret("HONEYCOMB_API_BASE_URL"),
    } : {}),
  },
});
export const honeycombStatus = defineFunction({
  name: "honeycomb-estimate-status", entry: "./status.ts", resourceGroupName: "data", timeoutSeconds: 10,
  environment: { HONEYCOMB_ENVIRONMENT: environment },
});

export const honeycombSubmissions = defineFunction({
  name: "honeycomb-submissions", entry: "./submissions.ts", resourceGroupName: "data", timeoutSeconds: 15,
  environment: runtimeEnvironment,
});
export const honeycombSubmissionWorker = defineFunction({
  name: "honeycomb-submission-worker", entry: "./submission-worker.ts", resourceGroupName: "data",
  timeoutSeconds: 90, memoryMB: 512,
  environment: {
    ...runtimeEnvironment,
    ...(enabled ? {
      HONEYCOMB_API_USER: secret("HONEYCOMB_API_USER"),
      HONEYCOMB_PRODUCER_ID: secret("HONEYCOMB_PRODUCER_ID"),
      HONEYCOMB_API_SECRET_KEY: secret("HONEYCOMB_API_SECRET_KEY"),
      HONEYCOMB_API_BASE_URL: secret("HONEYCOMB_API_BASE_URL"),
    } : {}),
  },
});
