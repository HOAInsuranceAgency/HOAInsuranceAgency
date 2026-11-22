import { describe, expect, it } from "vitest";
import { parseScheduleJson } from "../../../../shared/premiumFinance/schedule";

describe("frozen financing schedules", () => {
  it("reads every historical AWSJSON encoding", () => {
    const rows = [{ n: 1, dueDate: "2026-10-01", payment: 101, principal: 100, interest: 1, balance: 0 }];
    for (const stored of [rows, JSON.stringify(rows), JSON.stringify(JSON.stringify(rows))]) {
      expect(parseScheduleJson(stored)).toEqual(rows);
    }
  });

  it("returns an empty schedule for invalid inputs", () => {
    for (const stored of [null, undefined, "not json", "42", {}]) expect(parseScheduleJson(stored)).toEqual([]);
  });
});
