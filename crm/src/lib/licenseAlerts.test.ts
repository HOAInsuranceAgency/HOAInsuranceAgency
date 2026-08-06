import { describe, expect, it } from "vitest";
import {
  REMINDER_DAYS,
  addDays,
  dedupeKeyFor,
  dueReminders,
  reminderThreshold,
  renderDigest,
  type LicenseLike,
} from "../../amplify/functions/license-alerts/digest";
import { LICENSE_EXPIRY_SCALE } from "./badges";

const TODAY = "2026-08-06";

const license = (over: Partial<LicenseLike> = {}): LicenseLike => ({
  id: "lic-1",
  holderType: "PRODUCER",
  holderName: "Jane Doe",
  state: "MA",
  licenseNumber: "1234567",
  licenseClass: "PRODUCER",
  status: "ACTIVE",
  expirationDate: addDays(TODAY, 45),
  ...over,
});

/** The tightest rung reached by a licence expiring `n` days from today. */
const at = (n: number, over: Partial<LicenseLike> = {}) =>
  reminderThreshold(license({ expirationDate: addDays(TODAY, n), ...over }), TODAY);

describe("reminderThreshold", () => {
  it("says nothing for a licence beyond the outermost rung", () => {
    expect(at(61)).toBeNull();
    expect(at(365)).toBeNull();
  });

  it("fires each rung inclusively, matching the badge cutoffs", () => {
    // 60 and 30 are LICENSE_EXPIRY_SCALE's amber and red cutoffs, and that
    // scale is inclusive — 60d left is already amber. The email has to change
    // on the same day the badge does or the two tell different stories.
    expect(LICENSE_EXPIRY_SCALE.soon).toBe(60);
    expect(LICENSE_EXPIRY_SCALE.urgent).toBe(30);
    expect(at(60)).toBe(60);
    expect(at(31)).toBe(60);
    expect(at(30)).toBe(30);
    expect(at(4)).toBe(30);
    expect(at(3)).toBe(3);
  });

  it("reports the tightest rung, not every rung reached", () => {
    // A licence entered with five days left has technically "reached" 60 and
    // 30 without either ever having been useful to say. One email, not three.
    expect(at(5)).toBe(30);
  });

  it("still fires on the day itself and after it", () => {
    expect(at(0)).toBe(3);
    expect(at(-1)).toBe(3);
    expect(at(-400)).toBe(3);
  });

  it("ignores a licence that is already off the road", () => {
    // licenseHealth's status override: LAPSED/INACTIVE/EXPIRED are red on the
    // Licensing screen whatever the date says, so counting down to the expiry
    // of something that stopped being usable is noise in a shared inbox.
    for (const status of ["LAPSED", "INACTIVE", "EXPIRED"]) {
      expect(at(10, { status })).toBeNull();
    }
    // ACTIVE and PENDING fall through to the ladder, as they do in the UI.
    expect(at(10, { status: "PENDING" })).toBe(30);
    expect(at(10, { status: null })).toBe(30);
  });

  it("ignores a licence with no usable expiration date", () => {
    expect(reminderThreshold(license({ expirationDate: null }), TODAY)).toBeNull();
    expect(reminderThreshold(license({ expirationDate: "" }), TODAY)).toBeNull();
    expect(reminderThreshold(license({ expirationDate: "soon" }), TODAY)).toBeNull();
    // Not a day string — the ladder compares text, so a datetime would sort
    // wrong at the boundary rather than fail loudly.
    expect(
      reminderThreshold(license({ expirationDate: "2026-09-05T00:00:00Z" }), TODAY)
    ).toBeNull();
  });

  it("covers both holder types", () => {
    expect(at(30, { holderType: "FIRM", holderName: null })).toBe(30);
    expect(at(30, { holderType: "PRODUCER" })).toBe(30);
  });
});

describe("dedupeKeyFor", () => {
  it("re-arms every rung when the licence is renewed", () => {
    // The date is in the key precisely so this happens: renewing mints three
    // keys nothing has seen, rather than silencing the licence forever after
    // one cycle.
    const before = REMINDER_DAYS.map((d) => dedupeKeyFor("lic-1", "2026-09-05", d));
    const after = REMINDER_DAYS.map((d) => dedupeKeyFor("lic-1", "2028-09-05", d));
    expect(new Set([...before, ...after]).size).toBe(6);
  });

  it("keys each rung separately", () => {
    expect(dedupeKeyFor("lic-1", "2026-09-05", 30)).not.toBe(
      dedupeKeyFor("lic-1", "2026-09-05", 3)
    );
  });
});

describe("dueReminders", () => {
  it("returns one reminder per due licence, soonest first", () => {
    const due = dueReminders(
      [
        license({ id: "far", expirationDate: addDays(TODAY, 50) }),
        license({ id: "near", expirationDate: addDays(TODAY, 2) }),
        license({ id: "never", expirationDate: addDays(TODAY, 200) }),
      ],
      TODAY
    );
    expect(due.map((r) => r.licenseId)).toEqual(["near", "far"]);
    expect(due[0]).toMatchObject({ threshold: 3, expired: false });
    expect(due[1]).toMatchObject({ threshold: 60, expired: false });
  });

  it("flags a date that has already passed", () => {
    const [r] = dueReminders(
      [license({ expirationDate: addDays(TODAY, -2) })],
      TODAY
    );
    expect(r.expired).toBe(true);
  });

  it("names a firm licence after the agency when it has no holder", () => {
    const [r] = dueReminders(
      [license({ holderType: "FIRM", holderName: null, expirationDate: addDays(TODAY, 10) })],
      TODAY
    );
    expect(r.line).toContain("HOA Insurance Agency LLC");
    expect(r.line).toContain("MA");
    expect(r.line).toContain("#1234567");
  });
});

describe("renderDigest", () => {
  const digest = () =>
    renderDigest(
      dueReminders(
        [
          license({ id: "a", expirationDate: addDays(TODAY, -1) }),
          license({ id: "b", expirationDate: addDays(TODAY, 2) }),
          license({ id: "c", expirationDate: addDays(TODAY, 20) }),
          license({ id: "d", expirationDate: addDays(TODAY, 55) }),
        ],
        TODAY
      )
    );

  it("summarises the run in the subject line", () => {
    expect(digest().subject).toBe(
      "License expirations — 1 already expired, 1 expiring within 3 days, " +
        "1 expiring within 30 days, 1 expiring within 60 days"
    );
  });

  it("orders sections worst first", () => {
    const { text } = digest();
    const order = ["Already expired", "within 3 days", "within 30 days", "within 60 days"];
    const positions = order.map((h) => text.indexOf(h));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((x, y) => x - y)).toEqual(positions);
  });

  it("drops sections with nothing in them", () => {
    const { subject, text } = renderDigest(
      dueReminders([license({ expirationDate: addDays(TODAY, 55) })], TODAY)
    );
    expect(subject).toBe("License expirations — 1 expiring within 60 days");
    expect(text).not.toContain("3 days");
    expect(text).not.toContain("expired");
  });

  it("escapes holder text in the HTML body", () => {
    // holderName is free text typed on the Licensing screen; it reaches a
    // mail client as markup unless something stops it.
    const { html } = renderDigest(
      dueReminders(
        [license({ holderName: 'Jane <script>alert("x")</script> Doe' })],
        TODAY
      )
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
