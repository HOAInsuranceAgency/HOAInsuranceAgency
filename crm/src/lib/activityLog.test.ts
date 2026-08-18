import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const getCurrentUser = vi.hoisted(() => vi.fn());
const models = vi.hoisted(() => ({
  Building: { create: vi.fn(), update: vi.fn(), delete: vi.fn(), list: vi.fn() },
  Carrier: { create: vi.fn(), update: vi.fn() },
}));
vi.mock("aws-amplify/data", () => ({ generateClient: () => ({ models }) }));
vi.mock("aws-amplify/auth", () => ({ getCurrentUser }));

import {
  buildSummary,
  diffImages,
  fieldLabel,
  resolveEntityId,
  subjectLabel,
} from "../../amplify/functions/activity-log/diff";
import { subjectTypeFromArn } from "../../amplify/functions/activity-log/handler";

/**
 * The activity log's testable half.
 *
 * The stream wiring itself cannot be exercised without a deploy — there is no
 * DynamoDB, no Lambda and no AWS account here. So the logic that decides what
 * a change *means* lives in a module that imports nothing, and this covers it:
 * the diff, the noise list, which account a record belongs to, and the
 * sentence a reader actually sees.
 */

describe("diffImages", () => {
  it("reports a changed field with both sides", () => {
    expect(diffImages({ sqft: 1000 }, { sqft: 1200 })).toEqual([
      { field: "sqft", from: 1000, to: 1200 },
    ]);
  });

  it("counts clearing a value as a change", () => {
    // An Amplify update that sets a column to null is how a user blanks a
    // field, and "removed the roof year" is exactly what a timeline is for.
    expect(diffImages({ roofYear: 2019 }, {})).toEqual([
      { field: "roofYear", from: 2019, to: null },
    ]);
  });

  it("ignores the noise list", () => {
    const before = { sqft: 1000, updatedAt: "1", lastWriteBy: "a", ocrText: "x" };
    const after = { sqft: 1000, updatedAt: "2", lastWriteBy: "b", ocrText: "y" };
    // updatedAt moves on every write, so including it would make every diff
    // non-empty and every no-op save produce a row. lastWriteBy is the
    // attribution mechanism — showing it as a change would print it beside
    // the change it describes.
    expect(diffImages(before, after)).toEqual([]);
  });

  it("keeps identifiers out of the timeline", () => {
    // Found by reading a real timeline: adding one contact rendered three
    // lines of bookkeeping above the two a person came to read. None of them
    // can ever say anything — an id is assigned and never changes, accountId
    // is the account whose timeline this already is, and extractionSourceKey
    // is the key W9 matches on.
    const changes = diffImages(undefined, {
      id: "c1",
      accountId: "a1",
      extractionSourceKey: "name:dana whitfield|",
      name: "Dana Whitfield",
    });
    expect(changes).toEqual([{ field: "name", from: null, to: "Dana Whitfield" }]);
  });

  it("keeps the extraction marker out but leaves the extraction itself in", () => {
    // The line this draws: a field describing the association stays, one
    // describing the app's bookkeeping about it goes. An extraction that ran
    // and failed is an event somebody started — and with the aiExtraction
    // blob filtered out, these two columns are the only trace of it left.
    expect(
      diffImages(
        { extractionStatus: "PENDING" },
        {
          extractionStatus: "FAILED",
          extractionError: "No OCR-complete documents on this account.",
          aiExtractionAppliedAt: "2026-08-01T10:00:00.000Z",
          aiExtraction: "{...}",
        }
      ).map((c) => c.field)
    ).toEqual(["extractionError", "extractionStatus"]);
  });

  it("does not swallow an identifier that means something to a person", () => {
    // `buildiumId` is the property manager's own reference. A pattern like
    // /Id$/ would have been shorter and would have hidden it.
    expect(
      diffImages({ buildiumId: "111" }, { buildiumId: "222" })
    ).toEqual([{ field: "buildiumId", from: "111", to: "222" }]);
  });

  it("compares arrays and JSON blobs by value, not by reference", () => {
    expect(diffImages({ lines: ["a", "b"] }, { lines: ["a", "b"] })).toEqual([]);
    expect(diffImages({ lines: ["a"] }, { lines: ["a", "b"] })).toHaveLength(1);
  });

  it("orders changes stably, so one event always produces one row", () => {
    const changes = diffImages({}, { zip: "1", address: "2", city: "3" });
    expect(changes.map((c) => c.field)).toEqual(["address", "city", "zip"]);
  });
});

describe("resolveEntityId", () => {
  it("takes accountId for anything that hangs off an account", () => {
    expect(resolveEntityId("Building", { accountId: "a1" })).toBe("a1");
  });

  it("takes the Account's own id, because it hangs off nothing", () => {
    // The account is the one streamed model with no `accountId` — it IS the
    // account. Falling through to `image.accountId` returned null for every
    // one of its changes, so the tab that promises "every write to this
    // account and everything under it" showed only the second half: renaming
    // the association, its entity type, its annual revenue, its fire district
    // and the lead → client conversion all left no trace.
    expect(resolveEntityId("Account", { id: "a1", name: "Willow Creek" })).toBe(
      "a1"
    );
  });

  it("takes Document's entityId only when it is an account", () => {
    // Document is polymorphic. A licence or carrier upload has an entityId
    // that is not an account, and filing it under one would put a licence in
    // some association's timeline.
    expect(
      resolveEntityId("Document", { entityType: "ACCOUNT", entityId: "a1" })
    ).toBe("a1");
    expect(
      resolveEntityId("Document", { entityType: "LICENSE", entityId: "l1" })
    ).toBeNull();
  });

  it("returns null for a record with no account, so it is dropped", () => {
    expect(resolveEntityId("Building", {})).toBeNull();
    expect(resolveEntityId("Building", undefined)).toBeNull();
  });
});

describe("subjectLabel", () => {
  it("finds whichever title field the model happens to use", () => {
    expect(subjectLabel("Building", { label: "Clubhouse" })).toBe("Clubhouse");
    expect(subjectLabel("Contact", { name: "Pat Alvarez" })).toBe("Pat Alvarez");
    expect(subjectLabel("Blanket", { blanketNumber: "BL-1" })).toBe("BL-1");
  });

  it("identifies a loss by date and line, having no name to use", () => {
    expect(
      subjectLabel("Loss", { dateOfLoss: "2026-01-09", lineOfBusiness: "Property" })
    ).toBe("2026-01-09 Property");
  });

  it("returns empty rather than an id nobody can read", () => {
    expect(subjectLabel("GlApplication", { id: "x" })).toBe("");
  });
});

describe("buildSummary", () => {
  it("names what was added or deleted", () => {
    expect(buildSummary("CREATE", "Building", "Clubhouse", [])).toBe(
      "Added Building Clubhouse"
    );
    expect(buildSummary("DELETE", "Quote", "Travelers", [])).toBe(
      "Deleted Quote Travelers"
    );
  });

  it("spells out one or two changes", () => {
    expect(
      buildSummary("UPDATE", "Policy", "", [
        { field: "effectiveDate", from: "2026-01-01", to: "2026-03-01" },
      ])
    ).toBe("Effective date 2026-01-01 → 2026-03-01");
  });

  it("counts rather than lists a wide update", () => {
    const changes = ["a", "b", "c", "d"].map((f) => ({ field: f, from: 1, to: 2 }));
    expect(buildSummary("UPDATE", "Building", "Clubhouse", changes)).toBe(
      "Updated 4 fields on Building Clubhouse"
    );
  });

  it("reads a blank and a boolean as words, not as null and true", () => {
    expect(
      buildSummary("UPDATE", "Building", "", [
        { field: "historicalLandmark", from: null, to: true },
      ])
    ).toBe("Historical landmark blank → yes");
  });
});

describe("fieldLabel", () => {
  it("turns a column name into something a person reads", () => {
    expect(fieldLabel("distanceToHydrantFt")).toBe("Distance to hydrant ft");
    expect(fieldLabel("sqft")).toBe("Sqft");
  });
});

describe("subjectTypeFromArn", () => {
  it("reads the model out of an Amplify table ARN", () => {
    expect(
      subjectTypeFromArn(
        "arn:aws:dynamodb:us-east-1:1:table/Building-abc123-NONE/stream/2026"
      )
    ).toBe("Building");
  });

  it("returns null for anything it cannot parse, so the record is skipped", () => {
    expect(subjectTypeFromArn(undefined)).toBeNull();
    expect(subjectTypeFromArn("nonsense")).toBeNull();
  });
});

/**
 * The actor proxy. Attribution is the half of this feature streams cannot
 * provide, and it works by every write carrying `lastWriteBy` — so what is
 * worth asserting is that writes actually carry it without anyone remembering
 * to add it.
 */
describe("the actor proxy on `client`", () => {
  it("stamps lastWriteBy on a create and an update", async () => {
    getCurrentUser.mockResolvedValue({ userId: "sub-123" });
    vi.resetModules();
    const { client } = await import("./client");

    await client.models.Building.create({ accountId: "a1", label: "Clubhouse" });
    expect(models.Building.create).toHaveBeenCalledWith({
      accountId: "a1",
      label: "Clubhouse",
      lastWriteBy: "sub-123",
    });

    await client.models.Building.update({ id: "b1", label: "Annex" });
    expect(models.Building.update).toHaveBeenCalledWith({
      id: "b1",
      label: "Annex",
      lastWriteBy: "sub-123",
    });
  });

  it("leaves delete alone — there is nowhere to put an actor", async () => {
    getCurrentUser.mockResolvedValue({ userId: "sub-123" });
    vi.resetModules();
    const { client } = await import("./client");

    await client.models.Building.delete({ id: "b1" });
    // A real gap in attribution, and a deliberate one: a delete takes only an
    // id. The stream still records the removal, attributed to "system".
    expect(models.Building.delete).toHaveBeenCalledWith({ id: "b1" });
  });

  it("does not stamp a model that has no such column", async () => {
    getCurrentUser.mockResolvedValue({ userId: "sub-123" });
    vi.resetModules();
    const { client } = await import("./client");

    await client.models.Carrier.create({ name: "Travelers", appointed: false });
    // Carrier is not streamed and has no lastWriteBy — writing one would be
    // a GraphQL error on every carrier save.
    expect(models.Carrier.create).toHaveBeenCalledWith({
      name: "Travelers",
      appointed: false,
    });
  });

  it("writes without an actor rather than failing when there is no session", async () => {
    getCurrentUser.mockRejectedValue(new Error("no current user"));
    vi.resetModules();
    const { client } = await import("./client");

    await client.models.Building.create({ accountId: "a1" });
    expect(models.Building.create).toHaveBeenCalledWith({ accountId: "a1" });
  });
});

describe("the attributed and streamed model lists agree", () => {
  it("names the same models in both halves of the app", async () => {
    // A model streamed without the column is attributed to "System" forever;
    // one with the column and no stream carries a value nothing reads. Both
    // are silent, and finding out means reading an activity log that has been
    // wrong for months.
    const { ATTRIBUTED_MODELS } = await import("./client");
    const backend = readFileSync(
      resolve(process.cwd(), "amplify/backend.ts"),
      "utf8"
    );
    const block = /const STREAMED_MODELS = \[([\s\S]*?)\] as const;/.exec(backend);
    expect(block, "STREAMED_MODELS moved or was renamed").not.toBeNull();
    const streamed = [...block![1].matchAll(/"(\w+)"/g)].map((m) => m[1]);

    expect(streamed.length).toBeGreaterThan(10);
    expect([...streamed].sort()).toEqual([...ATTRIBUTED_MODELS].sort());
  });

  it("names the non-human writers the handler knows about", async () => {
    // A Lambda or the backfill script stamps its own name so the timeline can
    // say "Lead intake" rather than "System" — which is what an *unstamped*
    // write gets and should stay reserved for. A writer the handler has no
    // name for would render as a raw slug in the Who column.
    const handler = readFileSync(
      resolve(process.cwd(), "amplify/functions/activity-log/handler.ts"),
      "utf8"
    );
    const known = [
      ...(/const ROBOT_NAMES: Record<string, string> = \{([\s\S]*?)\};/
        .exec(handler)?.[1] ?? "")
        .matchAll(/"?([\w-]+)"?:/g),
    ].map((m) => m[1]);

    for (const [file, writer] of [
      ["amplify/functions/lead-intake/handler.ts", "lead-intake"],
      ["amplify/functions/extract-lead/handler.ts", "extract-lead"],
      ["scripts/backfill-lead-expansion.ts", "backfill"],
    ]) {
      const src = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(src, `${file} does not stamp an actor`).toContain(`"${writer}"`);
      expect(known, `${writer} has no display name`).toContain(writer);
    }
  });

  /** Kept beside the assertion it explains: STREAMED_MODELS in backend.ts. */
  const STREAMED_MODEL_COUNT = 14;

  it("gives every streamed model the column to be stamped into", () => {
    const schema = readFileSync(
      resolve(process.cwd(), "amplify/data/resource.ts"),
      "utf8"
    );
    // One `lastWriteBy` per streamed model, and not one more. A model that is
    // not streamed uses `updatedBy` instead — see AgencySettings and
    // UploadPortal, both of which tripped this test by naming the column
    // `lastWriteBy` first.
    const declared = [...schema.matchAll(/lastWriteBy: a\.string\(\)/g)].length;
    expect(declared).toBe(STREAMED_MODEL_COUNT);
  });
});
