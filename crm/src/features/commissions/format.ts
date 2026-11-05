import { fmtMoney } from "../../lib/client";

export const money = (cents: number) => fmtMoney(cents / 100);

export const today = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
