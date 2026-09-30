import { defineFunction } from "@aws-amplify/backend";

/** Deployment-only backfill; it is not exposed through the application API. */
export const migrateProducerLicenses = defineFunction({
  name: "migrate-producer-licenses",
  entry: "./handler.ts",
  timeoutSeconds: 900,
  resourceGroupName: "data",
});
