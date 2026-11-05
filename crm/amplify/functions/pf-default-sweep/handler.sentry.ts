import { monitorHandler } from "../monitoring";
import { handler as originalHandler } from "./handler";
export const handler = monitorHandler(originalHandler, "pf-default-sweep.handler");
