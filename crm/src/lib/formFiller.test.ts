import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PLACEHOLDER_RE,
  sanitiseSuggestions,
} from "../../amplify/functions/form-filler/sanitise";

/**
 * The AI form filler's output gate.
 *
 * The Lambda itself cannot be exercised here — no AppSync, no account, no
 * model — so the part that decides what is allowed onto a carrier's copy of
 * an ACORD form lives in a module that imports nothing, and this covers it.
 *
 * The requirement being tested is the one the user stated: if a value is
 * unknown, the field is blank. Never "pending info" or similar.
 */

const FIELDS = ["Insured_FullName_A", "Insured_MailingAddress_LineOne_A"];

describe("sanitiseSuggestions", () => {
  it("keeps a value the model answered for a requested field", () => {
    expect(
      sanitiseSuggestions(
        {
          fields: [
            {
              field: "Insured_FullName_A",
              value: "  Maple Ridge Condominium Association, Inc.  ",
              why: "account.name",
            },
          ],
        },
        FIELDS
      )
    ).toEqual([
      {
        field: "Insured_FullName_A",
        value: "Maple Ridge Condominium Association, Inc.",
        why: "account.name",
      },
    ]);
  });

  it("accepts a bare array as well as { fields: [...] }", () => {
    expect(
      sanitiseSuggestions([{ field: FIELDS[0], value: "x", why: "" }], FIELDS)
    ).toHaveLength(1);
  });

  it("drops every placeholder the model might reach for", () => {
    // The whole point of the feature's hard rule. A blank on an ACORD form is
    // a blank; "pending" is a factual claim the agency did not make, and an
    // underwriter reads it as "there is an answer and it is coming".
    const placeholders = [
      "pending",
      "Pending info",
      "pending information",
      "TBD",
      "tbd",
      "To be determined",
      "to be advised",
      "To Be Provided",
      "N/A",
      "n/a",
      "NA",
      "unknown",
      "None provided",
      "See attached",
      "refer to",
      "various",
      "?",
      "???",
      "-",
      "---",
      "  TBD  ",
    ];
    for (const value of placeholders) {
      expect(
        sanitiseSuggestions([{ field: FIELDS[0], value, why: "" }], FIELDS),
        `"${value}" reached the form`
      ).toEqual([]);
    }
  });

  it("keeps a real value that merely contains a placeholder word", () => {
    // "Various Trades LLC" is a company; "N/A Holdings" is a name. The rule
    // is about a value that says nothing, not about a substring.
    for (const value of ["Various Trades LLC", "See Attached Schedule B, item 4"]) {
      expect(sanitiseSuggestions([{ field: FIELDS[0], value, why: "" }], FIELDS))
        .toHaveLength(1);
    }
  });

  it("drops a field nobody asked about", () => {
    // The model does not get to choose which fields are written. Only the
    // blanks the deterministic pass reported are on the table.
    expect(
      sanitiseSuggestions(
        [{ field: "Producer_AuthorizedRepresentative_Signature_A", value: "Jake", why: "" }],
        FIELDS
      )
    ).toEqual([]);
  });

  it("drops blanks, non-strings and the second answer for a field", () => {
    expect(
      sanitiseSuggestions(
        [
          { field: FIELDS[0], value: "" },
          { field: FIELDS[0], value: "   " },
          { field: FIELDS[1], value: 42 },
          { field: FIELDS[0], value: "First" },
          { field: FIELDS[0], value: "Second" },
        ],
        FIELDS
      )
    ).toEqual([{ field: FIELDS[0], value: "First", why: "" }]);
  });

  it("returns nothing rather than throwing on a shape it did not expect", () => {
    // A malformed response must cost the gap-fill, not the document.
    for (const raw of [null, undefined, "nope", 7, {}, { fields: "no" }, [null, 1]]) {
      expect(sanitiseSuggestions(raw, FIELDS)).toEqual([]);
    }
  });

  it("truncates a justification instead of letting it run", () => {
    const [only] = sanitiseSuggestions(
      [{ field: FIELDS[0], value: "x", why: "y".repeat(500) }],
      FIELDS
    );
    expect(only.why.length).toBe(200);
  });
});

describe("the model pin", () => {
  it("is one constant, imported rather than repeated", async () => {
    // Two independent pins drift: the day one handler is upgraded and the
    // other is not, a lead extracted by one model is completed on a carrier
    // form by another, and nothing in the app says so.
    const { CLAUDE_MODEL } = await import("../../amplify/functions/model");
    expect(CLAUDE_MODEL).toMatch(/^claude-/);

    for (const file of [
      "amplify/functions/extract-lead/handler.ts",
      "amplify/functions/form-filler/handler.ts",
    ]) {
      const src = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(src, `${file} does not import the shared pin`).toContain(
        "CLAUDE_MODEL"
      );
      // A literal model id anywhere in a handler is a second pin.
      expect(
        /"claude-[\w.-]+"/.exec(src)?.[0],
        `${file} pins a model id inline`
      ).toBeUndefined();
    }
  });
});

describe("the field cap", () => {
  it("is one constant both halves import", async () => {
    // The browser slices before it sends and the Lambda slices before it
    // asks, so these have to agree. Two numbers would eventually not, and the
    // failure is silent in the worst direction: the browser reports only what
    // *it* dropped, so a lower cap on the Lambda would trim the tail with
    // nobody told — a silent cap, which is the one thing this feature's
    // reporting exists to prevent.
    const { MAX_FIELDS } = await import(
      "../../amplify/functions/form-filler/sanitise"
    );
    expect(MAX_FIELDS).toBeGreaterThan(0);

    for (const file of [
      "amplify/functions/form-filler/handler.ts",
      "src/lib/aiFill.ts",
    ]) {
      const src = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(src, `${file} does not import the shared cap`).toMatch(
        /import \{[^}]*MAX_FIELDS/
      );
      // A second number to slice by is the drift this prevents.
      expect(
        /\.slice\(0,\s*\d/.test(src),
        `${file} slices by a literal instead of the shared cap`
      ).toBe(false);
    }
  });
});

describe("PLACEHOLDER_RE", () => {
  it("is anchored, so it cannot swallow a whole value on a partial match", () => {
    expect(PLACEHOLDER_RE.source.startsWith("^")).toBe(true);
    expect(PLACEHOLDER_RE.source.endsWith("$")).toBe(true);
  });
});
