import { monitorHandler } from "../monitoring";
import { handler as originalHandler } from "./assignmentIndex";
export const handler = monitorHandler(originalHandler, "communications.assignmentIndex");
