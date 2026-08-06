import { marshall } from "@aws-sdk/util-dynamodb";
import type { DynamoDBStreamEvent } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";

const models = vi.hoisted(() => ({
  Activity: { create: vi.fn() },
  UserProfile: { listUserProfileByUserId: vi.fn() },
}));
vi.mock("aws-amplify/data", () => ({ generateClient: () => ({ models }) }));
vi.mock("aws-amplify", () => ({ Amplify: { configure: vi.fn() } }));
vi.mock("@aws-amplify/backend/function/runtime", () => ({
  getAmplifyDataClientConfig: async () => ({
    resourceConfig: {},
    libraryOptions: {},
  }),
}));

import { handler } from "../../amplify/functions/activity-log/handler";

/**
 * The stream handler's delivery contract.
 *
 * A DynamoDB Streams event source mapping is at-least-once: a batch that
 * fails part-way is redelivered whole, and `retryAttempts: 2` in backend.ts
 * means that can happen twice more. Without an idempotency key every record
 * already written gets written again, and one database change shows up as
 * three entries in a timeline whose whole value is being trustworthy.
 *
 * The Lambda itself cannot be deployed here, but this is the part that
 * decides what a replay does, and it is exercisable.
 */

const ARN =
  "arn:aws:dynamodb:us-east-1:1:table/Building-abc123-NONE/stream/2026";

const record = (over: Record<string, unknown> = {}) => ({
  eventID: "e-1111",
  eventName: "INSERT",
  eventSourceARN: ARN,
  dynamodb: {
    SequenceNumber: "100",
    ApproximateCreationDateTime: 1_767_225_600,
    NewImage: marshall({ id: "b1", accountId: "a1", label: "Clubhouse" }),
  },
  ...over,
});

const deliver = (over: Record<string, unknown> = {}) =>
  handler({ Records: [record(over)] } as unknown as DynamoDBStreamEvent);

beforeEach(() => {
  models.Activity.create.mockReset();
  models.UserProfile.listUserProfileByUserId.mockReset();
  models.Activity.create.mockImplementation(async () => ({ data: { id: "x" } }));
  models.UserProfile.listUserProfileByUserId.mockImplementation(async () => ({
    data: [],
  }));
});

describe("idempotency", () => {
  it("keys the row on the stream record, not on a fresh id", async () => {
    await deliver();
    expect(models.Activity.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: "e-1111", entityId: "a1" })
    );
  });

  it("writes the same id when the same record is delivered twice", async () => {
    // The mock cannot enforce the database's condition, so what is asserted
    // is the thing that makes the condition bite: two deliveries of one
    // record claim one id, and the second create is the one DynamoDB rejects.
    await deliver();
    await deliver();
    const ids = models.Activity.create.mock.calls.map((c) => c[0].id);
    expect(ids).toEqual(["e-1111", "e-1111"]);
  });

  it("does not log a rejected replay as a failure", async () => {
    // A redelivery losing the id condition is the mechanism working. Logging
    // it as an error would make a healthy retry look like a broken Lambda.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    models.Activity.create.mockImplementation(async () => ({
      data: null,
      errors: [{ message: "The conditional request failed" }],
    }));
    await deliver();
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it("still logs a write that failed for any other reason", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    models.Activity.create.mockImplementation(async () => ({
      data: null,
      errors: [{ message: "Unauthorized" }],
    }));
    await deliver();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("subjectId", () => {
  it("falls back to the account for a model keyed on it", async () => {
    // GlApplication and DoApplication declare `.identifier(["accountId"])`,
    // so their images carry no `id` at all and this would be blank.
    await deliver({
      eventSourceARN:
        "arn:aws:dynamodb:us-east-1:1:table/GlApplication-abc123-NONE/stream/2026",
      dynamodb: {
        SequenceNumber: "101",
        ApproximateCreationDateTime: 1_767_225_600,
        NewImage: marshall({ accountId: "a1", fullTimeEmployees: 4 }),
      },
    });
    expect(models.Activity.create).toHaveBeenCalledWith(
      expect.objectContaining({ subjectType: "GlApplication", subjectId: "a1" })
    );
  });
});
