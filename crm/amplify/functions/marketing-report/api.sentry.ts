import { batchLiveChanges } from "../live-write";
import { monitorHandler } from "../monitoring";
import { handler as originalHandler } from "./api";
export const handler = monitorHandler(batchLiveChanges(originalHandler), "marketing-report.api");
