import { monitorHandler } from "../monitoring";
import { handler as originalHandler } from "./payroll-worker";
export const handler = monitorHandler(originalHandler, "commissions.payroll-worker");
