import { monitorHandler } from "../monitoring";
import { handler as originalHandler } from "./status";
export const handler = monitorHandler(originalHandler, "honeycomb.status");
