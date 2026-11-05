import { monitorHandler } from "../monitoring";
import { handler as originalHandler } from "./handler";
export const handler = monitorHandler(originalHandler, "upload-portal.handler");
