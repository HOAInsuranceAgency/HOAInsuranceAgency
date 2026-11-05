import { monitorHandler } from "../monitoring";
import { handler as originalHandler } from "./verify";
export const handler = monitorHandler(originalHandler, "magic-link.verify");
