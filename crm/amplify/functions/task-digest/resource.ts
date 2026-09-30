import { defineFunction } from "@aws-amplify/backend";

/** Retired compatibility definition; not registered in the backend and never scheduled. */
export const taskDigest = defineFunction({ name: "task-digest", entry: "./handler.ts", resourceGroupName: "data" });
