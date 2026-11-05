import { monitorHandler } from "../monitoring";
import { handler as originalHandler } from "./create";
export const handler = monitorHandler(originalHandler, "magic-link.create");
