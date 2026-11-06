import { monitorHandler } from "../monitoring";
import { handler as originalHandler } from "./reports";
export const handler = monitorHandler(originalHandler, "communications.reports");
