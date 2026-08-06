import { describe, expect, it } from "vitest";
import { classifyCandidate } from "./extractionMatch";
import {
  buildingAliases,
  buildingKey,
  contactAliases,
  contactKey,
  lossAliases,
  lossKey,
} from "./extractionKeys";

/**
 * The rule that stops re-running an extraction from duplicating everything it
 * already applied.
 *
 * Two verdicts would have been enough to stop the duplicates; there are three
 * because "matches, and changes nothing" is a write too — one that bumps
 * `updatedAt`, shows as an edit in the activity log, and tells a reviewer
 * something happened when nothing did.
 */

const buildings = [
  {
    id: "b1",
    extractionSourceKey: buildingKey({ label: "Clubhouse" }),
    label: "Clubhouse",
    sqft: 4200,
    yearBuilt: 1985,
  },
];

describe("classifyCandidate", () => {
  it("calls a candidate with no match new", () => {
    const m = classifyCandidate(
      buildingKey({ label: "Pool House" }),
      { label: "Pool House", sqft: 900 },
      buildings
    );
    expect(m.verdict).toBe("new");
    expect(m.existing).toBeUndefined();
  });

  it("calls an unchanged candidate identical, not an update", () => {
    // This is the case that produced today's duplicates: apply the same
    // extraction twice and the second pass has nothing to do.
    const m = classifyCandidate(
      buildingKey({ label: "Clubhouse" }),
      { label: "Clubhouse", sqft: 4200, yearBuilt: 1985 },
      buildings
    );
    expect(m.verdict).toBe("identical");
    expect(m.changes).toEqual([]);
    expect(m.existing?.id).toBe("b1");
  });

  it("reports what would change, and only what would change", () => {
    const m = classifyCandidate(
      buildingKey({ label: "Clubhouse" }),
      { label: "Clubhouse", sqft: 4600, yearBuilt: 1985 },
      buildings
    );
    expect(m.verdict).toBe("update");
    expect(m.changes).toEqual([{ field: "sqft", from: 4200, to: 4600 }]);
  });

  it("treats a field the documents were silent about as absent, not blank", () => {
    // The apply path merges rather than replaces. An extraction that found a
    // building but said nothing about its year must not blank a year somebody
    // typed by hand, and must not read as a change either.
    const m = classifyCandidate(
      buildingKey({ label: "Clubhouse" }),
      { label: "Clubhouse" },
      buildings
    );
    expect(m.verdict).toBe("identical");
  });

  it("does not see a difference between 1985 and \"1985\"", () => {
    // The two sides come from different places — a supplied value has been
    // coerced toward the column type, a stored one is whatever the API
    // returned. Treating that as a change would make every re-apply an update.
    const m = classifyCandidate(
      buildingKey({ label: "Clubhouse" }),
      { yearBuilt: "1985" },
      buildings
    );
    expect(m.verdict).toBe("identical");
  });

  it("does not see a difference between null and empty string", () => {
    const rows = [{ id: "x", extractionSourceKey: "k", note: null }];
    expect(classifyCandidate("k", { note: "" }, rows).verdict).toBe("identical");
    expect(classifyCandidate("k", { note: "something" }, rows).changes).toEqual([
      { field: "note", from: null, to: "something" },
    ]);
  });

  it("reads an explicit undefined as not-supplied, not as a blanking", () => {
    // `ExtractionPanel` strips undefined before it gets here, so this is the
    // contract for any other caller: a key with no value is a column the
    // documents said nothing about, and the merge must not treat it as an
    // instruction to clear what is stored.
    const rows = [{ id: "x", extractionSourceKey: "k", note: "typed by hand" }];
    expect(classifyCandidate("k", { note: undefined }, rows).verdict).toBe(
      "identical"
    );
  });

  it("orders changes stably, so one candidate always reads the same", () => {
    const rows = [{ id: "x", extractionSourceKey: "k", a: 1, b: 2, c: 3 }];
    const m = classifyCandidate("k", { c: 9, a: 8, b: 7 }, rows);
    expect(m.changes.map((c) => c.field)).toEqual(["a", "b", "c"]);
  });

  it("matches a contact by email across a changed name", () => {
    // The key does the matching, not the payload — which is the point of
    // keying a person on their email: "Pat Alvarez" becoming "Patricia
    // Alvarez" is a correction to one contact, not a second person.
    const contacts = [
      {
        id: "c1",
        extractionSourceKey: contactKey({ email: "PAT@example.com" }),
        name: "Pat Alvarez",
        email: "pat@example.com",
      },
    ];
    const m = classifyCandidate(
      contactKey({ email: "pat@example.com" }),
      { name: "Patricia Alvarez", email: "pat@example.com" },
      contacts
    );
    expect(m.verdict).toBe("update");
    expect(m.changes).toEqual([
      { field: "name", from: "Pat Alvarez", to: "Patricia Alvarez" },
    ]);
  });

  it("keys a loss on date, line and amount together", () => {
    const losses = [
      {
        id: "l1",
        extractionSourceKey: lossKey({
          dateOfLoss: "2024-03-14",
          lineOfBusiness: "Property",
          amountOfLoss: 18400,
        }),
        amountPaid: 18400,
      },
    ];
    // Same day, same line, different amount — a different occurrence.
    expect(
      classifyCandidate(
        lossKey({
          dateOfLoss: "2024-03-14",
          lineOfBusiness: "Property",
          amountOfLoss: 900,
        }),
        { amountPaid: 900 },
        losses
      ).verdict
    ).toBe("new");
  });
});

/**
 * Matching on the stored key alone, which is all this did until staging showed
 * otherwise. Each case below is a row that was already on the account and got
 * a second copy filed beside it on the first apply.
 */
describe("classifyCandidate with identity aliases", () => {
  it("matches a stored contact known by email against a candidate known by name", () => {
    // The case that duplicated Marion and Rosalind. The CRM holds their email,
    // so they were stored under `email:…`; the prior-policy packet named them
    // with a role and no address, so the candidate is `name:…|MANAGER`. Two
    // strings, one person — and comparing the strings said "new".
    const contacts = [
      {
        id: "c1",
        extractionSourceKey: contactKey({ email: "marion@willowcreek.example" }),
        name: "Marion Delacroix",
        email: "marion@willowcreek.example",
        type: "MANAGER",
        phone: "(617) 555-0142",
      },
    ];
    const supplied = {
      name: "Marion Delacroix",
      type: "MANAGER",
      phone: "(617) 555-0142",
    };
    const key = contactKey(supplied);

    expect(classifyCandidate(key, supplied, contacts).verdict).toBe("new");
    expect(
      classifyCandidate(key, supplied, contacts, contactAliases).verdict
    ).toBe("identical");
  });

  it("matches a contact whose email was added after it was stored", () => {
    // Terrence: created from a document with no address, so keyed on
    // name+role; someone then typed his email in, which changes what his
    // identity *derives* to but not the column it was stored under. Both names
    // have to keep working.
    const contacts = [
      {
        id: "c2",
        extractionSourceKey: contactKey({ name: "Terrence Bowe", type: "TRUSTEE" }),
        name: "Terrence Bowe",
        email: "terrence@willowcreek.example",
        type: "TRUSTEE",
      },
    ];
    const supplied = { name: "Terrence Bowe", type: "TRUSTEE" };
    expect(
      classifyCandidate(contactKey(supplied), supplied, contacts, contactAliases)
        .verdict
    ).toBe("identical");
  });

  it("matches a building that was added by hand and carries no key at all", () => {
    // `BuildingsCard` never wrote `extractionSourceKey`, so every hand-added
    // building was invisible to the stored-key comparison and an extraction
    // filed a second copy of the whole property schedule.
    // Typed with the column present but unset, which is what the row actually
    // is: `Building.extractionSourceKey` exists in the schema and this card
    // never wrote it.
    const stored: {
      id: string;
      label: string;
      sqft: number;
      extractionSourceKey?: string | null;
    }[] = [{ id: "b9", label: "Building A", sqft: 24500 }];
    const supplied = { label: "Building A", sqft: 24500 };
    const key = buildingKey(supplied);

    expect(classifyCandidate(key, supplied, stored).verdict).toBe("new");
    expect(
      classifyCandidate(key, supplied, stored, buildingAliases).verdict
    ).toBe("identical");
  });

  it("matches a loss whose amount was filled in after it was stored", () => {
    // A loss run gives a date and a line long before the adjuster settles on a
    // number, so the amount is the field most likely to arrive late — and it
    // is in the key.
    const losses = [
      {
        id: "l2",
        extractionSourceKey: lossKey({
          dateOfLoss: "2024-02-11",
          lineOfBusiness: "Property",
          amountOfLoss: null,
        }),
        dateOfLoss: "2024-02-11",
        lineOfBusiness: "Property",
        amountOfLoss: 52000,
        typeOfLoss: "Frozen pipe",
      },
    ];
    const supplied = {
      dateOfLoss: "2024-02-11",
      lineOfBusiness: "Property",
      amountOfLoss: 52000,
      typeOfLoss: "Frozen pipe",
    };
    expect(
      classifyCandidate(lossKey(supplied), supplied, losses, lossAliases).verdict
    ).toBe("identical");
  });

  it("still keeps two genuinely different losses apart", () => {
    // The weaker date-and-line alias must not collapse the case the amount is
    // in the key for: two occurrences on one day under one line.
    const losses = [
      {
        id: "l3",
        extractionSourceKey: lossKey({
          dateOfLoss: "2024-03-14",
          lineOfBusiness: "Property",
          amountOfLoss: 18400,
        }),
        dateOfLoss: "2024-03-14",
        lineOfBusiness: "Property",
        amountOfLoss: 18400,
      },
    ];
    const supplied = {
      dateOfLoss: "2024-03-14",
      lineOfBusiness: "Property",
      amountOfLoss: 900,
    };
    expect(
      classifyCandidate(lossKey(supplied), supplied, losses, lossAliases).verdict
    ).toBe("new");
  });

  it("does not merge two rows that have said nothing about who they are", () => {
    // A blank alias would be a name every anonymous row shares, and merging
    // two rows with nothing in common is a worse error than the duplicate this
    // whole mechanism exists to prevent.
    const contacts = [{ id: "c3", extractionSourceKey: null, name: "", type: "" }];
    const supplied = { name: "", type: "" };
    expect(
      classifyCandidate(contactKey(supplied), supplied, contacts, contactAliases)
        .verdict
    ).toBe("new");
  });

  it("keeps two people who share a name but not a role apart", () => {
    const contacts = [
      {
        id: "c4",
        extractionSourceKey: contactKey({ name: "Dana Whitfield", type: "TRUSTEE" }),
        name: "Dana Whitfield",
        type: "TRUSTEE",
      },
    ];
    const supplied = { name: "Dana Whitfield", type: "ACCOUNTING" };
    expect(
      classifyCandidate(contactKey(supplied), supplied, contacts, contactAliases)
        .verdict
    ).toBe("new");
  });
});

/**
 * The stored key is a record of the past, not a copy of the present.
 *
 * Cards used to recompute `extractionSourceKey` on every write. With only the
 * stored key to match on that was necessary — a corrected email had to move
 * the key with it. With aliases it is actively harmful: the row's *current*
 * identity is derived anyway, so all the recompute does is erase the one
 * thing only the stored key can say, which is what the row used to be called.
 *
 * Found on staging after the alias fix shipped: a loss created before anyone
 * knew its amount, then edited to add one, came back from a re-run as a new
 * loss — its stored key had been rewritten to include the amount, and the
 * document (which never stated one) could not name it.
 */
describe("a row keeps answering to the key it was created under", () => {
  it("matches a loss whose key was written before its amount was known", () => {
    const losses = [
      {
        id: "l4",
        // Created with no amount. NOT rewritten when the amount arrived.
        extractionSourceKey: lossKey({
          dateOfLoss: "2024-02-11",
          lineOfBusiness: "Property",
          amountOfLoss: null,
        }),
        dateOfLoss: "2024-02-11",
        lineOfBusiness: "Property",
        amountOfLoss: 52000,
      },
    ];
    // The loss run names the date and the line and no amount, as loss runs do.
    const supplied = { dateOfLoss: "2024-02-11", lineOfBusiness: "Property" };
    expect(
      classifyCandidate(lossKey(supplied), supplied, losses, lossAliases).verdict
    ).toBe("identical");
  });

  it("matches a contact by the email they had when the row was written", () => {
    const contacts = [
      {
        id: "c5",
        extractionSourceKey: contactKey({ email: "old@willowcreek.example" }),
        name: "Marion Delacroix",
        email: "new@willowcreek.example",
        type: "MANAGER",
      },
    ];
    // A packet filed before the correction still names the old address.
    const supplied = { name: "Marion Delacroix", email: "old@willowcreek.example" };
    expect(
      classifyCandidate(contactKey(supplied), supplied, contacts, contactAliases)
        .verdict
    ).toBe("update");
  });

  it("and by the one they have now", () => {
    const contacts = [
      {
        id: "c6",
        extractionSourceKey: contactKey({ email: "old@willowcreek.example" }),
        name: "Marion Delacroix",
        email: "new@willowcreek.example",
        type: "MANAGER",
      },
    ];
    const supplied = { name: "Marion Delacroix", email: "new@willowcreek.example" };
    expect(
      classifyCandidate(contactKey(supplied), supplied, contacts, contactAliases)
        .verdict
    ).toBe("identical");
  });
});

/**
 * The cards agree that the key is written once.
 *
 * A card that recomputes it on update reintroduces the loss bug above, and
 * the failure is silent — everything still saves, and the duplicate only
 * appears the next time somebody applies an extraction.
 */
describe("no card rewrites the key on update", () => {
  it("keeps extractionSourceKey out of every update path", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const cards = [
      "src/components/ContactsCard.tsx",
      "src/components/property/BlanketsCard.tsx",
      "src/components/property/BuildingsCard.tsx",
      "src/pages/account/LossesTab.tsx",
      "src/pages/account/PriorCarrierTab.tsx",
    ];
    for (const file of cards) {
      const src = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(src, `${file} never sets the key`).toMatch(/extractionSourceKey/);
      // The shared write helper is used by both paths, so the key must not be
      // in it — it belongs to the create alone.
      expect(
        /toUpdate:\s*toWrite/.test(src) &&
          /extractionSourceKey/.test(src.slice(src.indexOf("function toWrite"))),
        `${file} recomputes the key inside a shared toWrite`
      ).toBe(false);
    }
  });
});
