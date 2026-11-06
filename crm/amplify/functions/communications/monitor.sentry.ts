import { batchLiveChanges } from "../live-write";
import { monitorHandler } from "../monitoring";
import { handler as originalHandler } from "./monitor";
export const handler = monitorHandler(batchLiveChanges(originalHandler), "communications.monitor");
