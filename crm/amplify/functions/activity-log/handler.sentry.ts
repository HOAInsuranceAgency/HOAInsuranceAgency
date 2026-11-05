import { monitorHandler } from "../monitoring";
import { batchLiveChanges } from '../live-write';
import { handler as originalHandler } from "./handler";
export const handler = monitorHandler(batchLiveChanges(originalHandler), "activity-log.handler");
