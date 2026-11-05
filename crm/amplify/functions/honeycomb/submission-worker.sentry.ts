import { monitorHandler } from "../monitoring";
import { handler as originalHandler } from "./submission-worker";
export const handler = monitorHandler(originalHandler, "honeycomb.submission-worker");
