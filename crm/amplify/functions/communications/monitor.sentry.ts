import { monitorHandler } from "../monitoring";
import { handler as originalHandler } from "./monitor";
export const handler = monitorHandler(originalHandler, "communications.monitor");
