import { defineFunction } from "@aws-amplify/backend";

/** Retired compatibility definition; not registered in the backend and never scheduled. */
export const licenseAlerts = defineFunction({ name: "license-alerts", entry: "./handler.ts", resourceGroupName: "data" });
