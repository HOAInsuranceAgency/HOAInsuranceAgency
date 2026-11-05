import { monitorHandler } from "../monitoring";
import { handler as originalHandler } from "./verification";
export const handler = monitorHandler(originalHandler, "transactional-mail.verification");
