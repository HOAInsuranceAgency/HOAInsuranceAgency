import { monitorHandler } from "../monitoring";
import { handler as originalHandler } from "./worker";
export const handler = monitorHandler(originalHandler, "honeycomb.worker");
