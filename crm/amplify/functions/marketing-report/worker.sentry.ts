import { monitorHandler } from "../monitoring";
import { handler as originalHandler } from "./worker";
export const handler = monitorHandler(originalHandler, "marketing-report.worker");
