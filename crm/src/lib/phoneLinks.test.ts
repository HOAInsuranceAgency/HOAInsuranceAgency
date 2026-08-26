import { describe, expect, it } from "vitest";
import {
  accountLinkId,
  contactLinkId,
  planForAccount,
  planForContact,
  type Plan,
} from "../../amplify/functions/dialpad-phone-index/links";

/**
 * What the phone index does about a row that changed.
 *
 * The two things worth holding still are that an id is a pure function of the
 * row it projects — which is the whole basis for replay safety — and that
 * every way a number can stop being usable ends in the same delete. A link
 * left behind by a cleared number is worse than one that never existed: it
 * offers a stale candidate for a live call.
 */

const contact = (o: Record<string, unknown> = {}) => ({
  id: "c1",
  accountId: "a1",
  name: "Marcia Webb",
  phone: "508-233-2261",
  ...o,
});

const account = (o: Record<string, unknown> = {}) => ({
  id: "a1",
  name: "Beacon Hill Condo Trust",
  ...o,
});

const upserts = (plans: Plan[]) =>
  plans.filter((p): p is Extract<Plan, { kind: "upsert" }> => p.kind === "upsert");

describe("contact links", () => {
  it("projects a contact into one row under a derived id", () => {
    const [plan] = planForContact(undefined, contact(), "Beacon Hill Condo Trust");
    expect(plan).toEqual({
      kind: "upsert",
      link: {
        id: contactLinkId("c1"),
        e164: "+15082332261",
        accountId: "a1",
        contactId: "c1",
        accountName: "Beacon Hill Condo Trust",
        contactName: "Marcia Webb",
        source: "CONTACT",
      },
    });
  });

  it("indexes a number written with an extension", () => {
    // The caller ID will show the main line, so this contact has to be
    // findable by it — see callerIdE164.
    const [plan] = planForContact(undefined, contact({ phone: "508-233-2261 x14" }), null);
    expect(upserts([plan])[0].link.e164).toBe("+15082332261");
  });

  it("gives two people at one company the same number, not one row", () => {
    // A property manager's colleagues share a switchboard. Both index, both
    // become candidates, and the resolver's AMBIGUOUS path is what settles it.
    const a = planForContact(undefined, contact({ id: "c1", phone: "5551112222 x1" }), null);
    const b = planForContact(undefined, contact({ id: "c2", phone: "5551112222 x2" }), null);
    expect(upserts(a)[0].link.e164).toBe(upserts(b)[0].link.e164);
    expect(upserts(a)[0].link.id).not.toBe(upserts(b)[0].link.id);
  });

  it("deletes the link every way a number can stop being usable", () => {
    const gone = { kind: "delete", id: contactLinkId("c1") };
    // Cleared, blanked, never parseable, and the account link severed.
    expect(planForContact(contact(), contact({ phone: null }), null)).toEqual([gone]);
    expect(planForContact(contact(), contact({ phone: "   " }), null)).toEqual([gone]);
    expect(planForContact(contact(), contact({ phone: "call the office" }), null)).toEqual([gone]);
    expect(planForContact(contact(), contact({ accountId: null }), null)).toEqual([gone]);
    // And a REMOVE, which carries no new image at all.
    expect(planForContact(contact(), undefined, null)).toEqual([gone]);
  });

  it("follows a contact moved to another account", () => {
    const [plan] = planForContact(contact(), contact({ accountId: "a2" }), "Other Trust");
    expect(upserts([plan])[0].link).toMatchObject({
      id: contactLinkId("c1"),
      accountId: "a2",
    });
  });

  it("ignores a record with no id rather than writing a bad row", () => {
    expect(planForContact(undefined, contact({ id: null }), null)).toEqual([]);
  });
});

describe("account links", () => {
  it("indexes the deprecated contactPhone column", () => {
    // Dead to the app, but it is the only number a lead created before the
    // Contact backfill has — and those are the leads most likely to ring.
    const plans = planForAccount(undefined, account({ contactPhone: "508-555-1000" }));
    expect(upserts(plans)[0].link).toMatchObject({
      id: accountLinkId("a1"),
      e164: "+15085551000",
      accountId: "a1",
      contactId: null,
      source: "ACCOUNT",
    });
  });

  it("names the person from the deprecated contact columns when there is one", () => {
    const plans = planForAccount(
      undefined,
      account({ contactPhone: "5085551000", contactFirstName: "Dana", contactLastName: "Ruiz" })
    );
    expect(upserts(plans)[0].link.contactName).toBe("Dana Ruiz");
  });

  it("deletes the account link when the column holds nothing usable", () => {
    expect(planForAccount(account(), account({ contactPhone: null }))).toEqual([
      { kind: "delete", id: accountLinkId("a1") },
    ]);
  });

  it("fans a rename out across the account's links", () => {
    const plans = planForAccount(account(), account({ name: "Beacon Hill Trust" }));
    expect(plans).toContainEqual({
      kind: "renameAccount",
      accountId: "a1",
      accountName: "Beacon Hill Trust",
    });
  });

  it("does not fan out when the name did not change", () => {
    // Every account write would otherwise rewrite its contacts' links with
    // what they already say.
    const plans = planForAccount(account(), account({ unitCount: 42 }));
    expect(plans.some((p) => p.kind === "renameAccount")).toBe(false);
  });

  it("does not treat a first insert as a rename", () => {
    const plans = planForAccount(undefined, account());
    expect(plans.some((p) => p.kind === "renameAccount")).toBe(false);
  });

  it("purges every link when the account is deleted", () => {
    // Contacts are not necessarily deleted with their account, so their links
    // would otherwise offer a dead association as a candidate.
    expect(planForAccount(account(), undefined)).toEqual([
      { kind: "purgeAccount", accountId: "a1" },
    ]);
  });
});

describe("ids are a pure function of the source row", () => {
  it("is what makes a redelivered batch harmless", () => {
    // At-least-once delivery means the same record can arrive twice. Same
    // input, same id, same content — the second write is a no-op overwrite
    // rather than a duplicate row.
    const once = planForContact(undefined, contact(), "Beacon Hill Condo Trust");
    const twice = planForContact(undefined, contact(), "Beacon Hill Condo Trust");
    expect(once).toEqual(twice);
    expect(contactLinkId("c1")).toBe("contact:c1");
    expect(accountLinkId("a1")).toBe("account:a1");
  });
});
