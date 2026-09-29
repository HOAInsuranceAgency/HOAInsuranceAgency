import { defineFunction } from "@aws-amplify/backend";

/** Retired compatibility definition; not registered in the backend and never scheduled. */
export const opsRollup = defineFunction({ name: "ops-rollup", entry: "./handler.ts", resourceGroupName: "data" });
