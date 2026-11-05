import { monitorHandler } from "../monitoring";
import { handler as originalHandler } from "./native-message";
export const handler = monitorHandler(originalHandler, "magic-link.native-message");
