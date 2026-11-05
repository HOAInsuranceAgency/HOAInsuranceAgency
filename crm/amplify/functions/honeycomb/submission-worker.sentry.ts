import { monitorHandler } from "../monitoring";
import { batchLiveChanges } from '../live-write';
import { handler as originalHandler } from "./submission-worker";
export const handler = monitorHandler(batchLiveChanges(originalHandler), "honeycomb.submission-worker");
