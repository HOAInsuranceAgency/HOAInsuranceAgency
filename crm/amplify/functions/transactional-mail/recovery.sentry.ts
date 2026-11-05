import { monitorHandler } from "../monitoring";
import { handler as originalHandler } from "./recovery";
export const handler = monitorHandler(originalHandler, "transactional-mail.recovery");
