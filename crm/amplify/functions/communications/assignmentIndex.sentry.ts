import { batchLiveChanges } from "../live-write";
import { monitorHandler } from "../monitoring";
import { handler as originalHandler } from "./assignmentIndex";
export const handler = monitorHandler(batchLiveChanges(originalHandler), "communications.assignmentIndex");
