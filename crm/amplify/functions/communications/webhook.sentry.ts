import { monitorHandler } from "../monitoring";
import { handler as originalHandler } from "./webhook";
export const handler = monitorHandler(originalHandler, "communications.webhook");
