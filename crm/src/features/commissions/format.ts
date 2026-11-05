import { fmtMoney } from "../../lib/client";
import { agencyDay } from "../../../../shared/agencyTime";

export const money = (cents: number) => fmtMoney(cents / 100);

export const today = () => agencyDay(new Date());
