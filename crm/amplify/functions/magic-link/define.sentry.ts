import { monitorHandler } from "../monitoring";
import { handler as originalHandler } from "./define";
export const handler = monitorHandler(originalHandler, "magic-link.define");
