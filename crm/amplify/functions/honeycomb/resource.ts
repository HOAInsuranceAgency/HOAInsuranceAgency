import { defineFunction, secret } from "@aws-amplify/backend";

// No shared/production secret lookup and no carrier traffic outside staging.
const staging = process.env.AWS_BRANCH === "staging";
export const honeycombWorker = defineFunction({
  name: "honeycomb-estimate-worker", entry: "./worker.ts", resourceGroupName: "data",
  timeoutSeconds: 90, memoryMB: 512,
  environment: {
    HONEYCOMB_ENABLED: String(staging),
    ...(staging ? {
      HONEYCOMB_API_USER: secret("HONEYCOMB_API_USER"),
      HONEYCOMB_PRODUCER_ID: secret("HONEYCOMB_PRODUCER_ID"),
      HONEYCOMB_API_SECRET_KEY: secret("HONEYCOMB_API_SECRET_KEY"),
      HONEYCOMB_API_BASE_URL: secret("HONEYCOMB_API_BASE_URL"),
    } : {}),
  },
});
export const honeycombStatus = defineFunction({
  name: "honeycomb-estimate-status", entry: "./status.ts", resourceGroupName: "data", timeoutSeconds: 10,
});
