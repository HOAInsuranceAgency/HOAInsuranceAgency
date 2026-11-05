import { monitorHandler } from "../monitoring";
import { handler as originalHandler } from "./api";
export const handler = monitorHandler(originalHandler, "marketing-report.api");
