import { describe, expect, it } from "vitest";
import { classifyCandidate } from "./extractionMatch";
import { buildingKey, contactKey, lossKey } from "./extractionKeys";

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
