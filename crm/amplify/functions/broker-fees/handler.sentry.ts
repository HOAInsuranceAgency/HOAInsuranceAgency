import { batchLiveChanges } from "../live-write";
import { monitorHandler } from "../monitoring";
import { handler as originalHandler } from "./handler";
export const handler = monitorHandler(batchLiveChanges(originalHandler), "broker-fees.handler");
