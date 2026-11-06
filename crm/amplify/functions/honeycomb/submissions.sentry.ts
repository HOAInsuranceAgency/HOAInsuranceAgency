import { monitorHandler } from "../monitoring";
import { handler as originalHandler } from "./submissions";
export const handler = monitorHandler(originalHandler, "honeycomb.submissions");
