import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { GetCommand, PutCommand, QueryCommand, ScanCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { handleMigrationEvent, migrateProducerLicenseRows } from "../../amplify/functions/migrate-producer-licenses/migration";

type Row = Record<string, unknown>;
const source = (id: string, fields: Row = {}): Row => ({
  id, userProfileId: "profile-1", state: "FL", licenseNumber: `LIC-${id}`,
  createdAt: "2025-01-01T10:00:00.000Z", updatedAt: "2025-02-01T11:00:00.000Z",
  ...fields,
});
const idFor = (id: string) => `legacy-producer-license:${createHash("sha256").update(JSON.stringify(["profile-1", "FL", `LIC-${id}`.toUpperCase()])).digest("hex")}`;
const options = {
  legacyTable: "legacy", licenseTable: "licenses", profileTable: "profiles",
  profileIndex: "licensesByProfile", remainingTime: () => 900_000, sleep: async () => {},
};

function fixture(pages: Row[][], initial: Row[] = []) {
  const licenses = new Map(initial.map((row) => [row.id, row]));
  const send = vi.fn(async (command: ScanCommand | QueryCommand | GetCommand | PutCommand): Promise<{
    Items?: Row[]; Item?: Row; LastEvaluatedKey?: Row;
  }> => {
    if (command instanceof ScanCommand) {
      const index = Number(command.input.ExclusiveStartKey?.page ?? 0);
      return { Items: pages[index], LastEvaluatedKey: index + 1 < pages.length ? { page: index + 1 } : undefined };
    }
    if (command instanceof QueryCommand) {
      return { Items: [...licenses.values()].filter((row) => row.userProfileId === command.input.ExpressionAttributeValues?.[":profile"]) };
    }
    if (command instanceof GetCommand) {
      if (command.input.TableName === "licenses") return { Item: licenses.get(command.input.Key?.id) };
      return { Item: { id: command.input.Key?.id, firstName: "Jane", lastName: "Smith", npn: "987654" } };
    }
    if (command instanceof PutCommand) {
      const item = command.input.Item!;
      if (licenses.has(item.id)) {
        throw Object.assign(new Error("Already exists"), { name: "ConditionalCheckFailedException" });
      }
      licenses.set(item.id, item);
      return {};
    }
    throw new Error("Unexpected command");
  });
  const db = { send } as unknown as DynamoDBDocumentClient;
  return { db, send, licenses };
}

describe("deployment producer license migration", () => {
  it("copies every bounded source page and preserves known licensing and profile details", async () => {
    const old = source("one", { expirationDate: "2027-04-30", linesOfAuthority: ["Property", null, "Casualty"] });
    const { db, send, licenses } = fixture([[old], [], [source("two")]]);
    await expect(migrateProducerLicenseRows(db, options)).resolves.toEqual({ copied: 2, skipped: 0 });
    expect(licenses.get(idFor("one"))).toMatchObject({
      __typename: "License", holderType: "PRODUCER", userProfileId: "profile-1",
      holderName: "Jane Smith", npn: "987654", state: "FL", licenseNumber: "LIC-one",
      expirationDate: "2027-04-30", linesOfAuthority: ["Property", "Casualty"],
      createdAt: old.createdAt, updatedAt: old.updatedAt,
    });
    expect(licenses.get(idFor("one"))).not.toHaveProperty("status");
    expect(licenses.get(idFor("one"))).not.toHaveProperty("residency");
    const scans = send.mock.calls.flatMap(([command]) => command instanceof ScanCommand ? [command.input] : []);
    expect(scans).toHaveLength(3);
    expect(scans.every((input) => input.TableName === "legacy" && input.Limit === 25)).toBe(true);
    expect(scans[2].ExclusiveStartKey).toEqual({ page: 2 });
  });

  it("queries all pages of the profile index and preserves newer equivalent records", async () => {
    const newer = { ...source("modern", { licenseNumber: "lic-one" }), holderType: "PRODUCER", status: "SUSPENDED", notes: "Current details" };
    const { db, send, licenses } = fixture([[source("one")]], [newer]);
    const original = send.getMockImplementation()!;
    send.mockImplementation(async (command) => {
      if (command instanceof QueryCommand) {
        return command.input.ExclusiveStartKey
          ? { Items: [newer] }
          : { Items: [], LastEvaluatedKey: { id: "previous" } };
      }
      return original(command);
    });
    await expect(migrateProducerLicenseRows(db, options)).resolves.toEqual({ copied: 0, skipped: 1 });
    expect([...licenses.values()]).toEqual([newer]);
    const queries = send.mock.calls.flatMap(([command]) => command instanceof QueryCommand ? [command.input] : []);
    expect(queries).toHaveLength(2);
    expect(queries[1]).toMatchObject({
      TableName: "licenses", IndexName: "licensesByProfile", Limit: 25,
      ExpressionAttributeValues: { ":profile": "profile-1" }, ExclusiveStartKey: { id: "previous" },
    });
    expect(send.mock.calls.some(([command]) => command instanceof PutCommand)).toBe(false);
  });

  it("does not mistake a firm's license for the producer's license", async () => {
    const { db, licenses } = fixture([[source("one")]], [{ ...source("firm", { licenseNumber: "LIC-one" }), holderType: "FIRM" }]);
    await expect(migrateProducerLicenseRows(db, options)).resolves.toEqual({ copied: 1, skipped: 0 });
    expect(licenses.size).toBe(2);
  });

  it("skips duplicate legacy rows across pages even while the index omits recent writes", async () => {
    const { db, send, licenses } = fixture([[source("one")], [source("duplicate", { licenseNumber: " lic-one " })]]);
    const original = send.getMockImplementation()!;
    let queries = 0;
    send.mockImplementation(async (command) => command instanceof QueryCommand && ++queries === 1 ? { Items: [] } : original(command));
    await expect(migrateProducerLicenseRows(db, options)).resolves.toEqual({ copied: 1, skipped: 1 });
    expect(licenses.size).toBe(1);
  });

  it("repeats safely without overwriting an edited migrated row even if the index lags", async () => {
    const { db, send, licenses } = fixture([[source("one")]]);
    await migrateProducerLicenseRows(db, options);
    licenses.get(idFor("one"))!.status = "EXPIRED";
    const original = send.getMockImplementation()!;
    let queries = 0;
    send.mockImplementation(async (command) => command instanceof QueryCommand && ++queries === 1 ? { Items: [] } : original(command));
    await expect(migrateProducerLicenseRows(db, options)).resolves.toEqual({ copied: 0, skipped: 1 });
    expect(licenses.size).toBe(1);
    expect(licenses.get(idFor("one"))!.status).toBe("EXPIRED");
    const puts = send.mock.calls.flatMap(([command]) => command instanceof PutCommand ? [command.input] : []);
    expect(puts.every((input) => input.ConditionExpression === "attribute_not_exists(id)")).toBe(true);
  });

  it("fails deployment on a partial copy and completes only the missing records on retry", async () => {
    const { db, send, licenses } = fixture([[source("one"), source("two")]]);
    const original = send.getMockImplementation()!;
    let fail = true;
    send.mockImplementation(async (command) => {
      if (command instanceof PutCommand && command.input.Item?.id === idFor("two") && fail) {
        throw new Error("DynamoDB unavailable");
      }
      return original(command);
    });
    await expect(handleMigrationEvent({ RequestType: "Create" }, () => migrateProducerLicenseRows(db, options)))
      .rejects.toThrow("DynamoDB unavailable");
    expect(licenses.size).toBe(1);
    fail = false;
    await expect(handleMigrationEvent({ RequestType: "Update" }, () => migrateProducerLicenseRows(db, options)))
      .resolves.toMatchObject({ Data: { copied: 1, skipped: 1 } });
    expect(licenses.size).toBe(2);
  });

  it("avoids a duplicate if a retry encounters equivalent source rows in a different order before the index catches up", async () => {
    const pages = [[source("one"), source("two")]];
    const { db, send, licenses } = fixture(pages);
    const original = send.getMockImplementation()!;
    let fail = true;
    let queries = 0;
    send.mockImplementation(async (command) => {
      if (command instanceof QueryCommand && ++queries <= 2) return { Items: [] };
      if (command instanceof PutCommand && command.input.Item?.id === idFor("two") && fail) {
        throw new Error("Retry this copy");
      }
      return original(command);
    });
    await expect(migrateProducerLicenseRows(db, options)).rejects.toThrow("Retry this copy");
    expect(licenses.size).toBe(1);
    fail = false;
    pages[0] = [source("duplicate", { licenseNumber: " lic-one " }), source("one"), source("two")];
    await expect(migrateProducerLicenseRows(db, options)).resolves.toEqual({ copied: 1, skipped: 2 });
    expect(licenses.size).toBe(2);
    expect(licenses.has(idFor("one"))).toBe(true);
  });

  it("waits for new rows to become visible through the profile index before reporting success", async () => {
    const { db, send } = fixture([[source("one")]]);
    const original = send.getMockImplementation()!;
    let queries = 0;
    send.mockImplementation(async (command) => command instanceof QueryCommand && ++queries < 4 ? { Items: [] } : original(command));
    const sleep = vi.fn(async () => {});
    await expect(migrateProducerLicenseRows(db, { ...options, sleep })).resolves.toEqual({ copied: 1, skipped: 0 });
    expect(sleep.mock.calls).toEqual([[100], [200]]);
  });

  it("fails after bounded index-visibility retries without removing copied data", async () => {
    const { db, send, licenses } = fixture([[source("one")]]);
    const original = send.getMockImplementation()!;
    send.mockImplementation(async (command) => command instanceof QueryCommand ? { Items: [] } : original(command));
    const sleep = vi.fn(async () => {});
    await expect(migrateProducerLicenseRows(db, { ...options, sleep })).rejects.toThrow("not yet visible");
    expect(licenses.size).toBe(1);
    expect(sleep).toHaveBeenCalledTimes(6);
    expect(send.mock.calls.filter(([command]) => command instanceof QueryCommand)).toHaveLength(8);
  });

  it("stops before the invocation deadline and leaves completed rows retryable", async () => {
    const { db, licenses } = fixture([[source("one"), source("two")]]);
    await expect(migrateProducerLicenseRows(db, {
      ...options, remainingTime: () => licenses.size ? 40_000 : 900_000,
    })).rejects.toThrow("time budget");
    expect(licenses.size).toBe(1);
    await expect(migrateProducerLicenseRows(db, options)).resolves.toEqual({ copied: 1, skipped: 1 });
  });

  it("fails on unreadable sources instead of claiming the deployment migrated them", async () => {
    const { db, licenses } = fixture([[source("bad", { licenseNumber: null })]]);
    await expect(migrateProducerLicenseRows(db, options)).rejects.toThrow("missing licenseNumber");
    expect(licenses.size).toBe(0);
  });

  it("keeps orphaned source records without inventing holder details", async () => {
    const { db, send, licenses } = fixture([[source("one")]]);
    const original = send.getMockImplementation()!;
    send.mockImplementation(async (command) => command instanceof GetCommand ? {} : original(command));
    await migrateProducerLicenseRows(db, options);
    expect(licenses.get(idFor("one"))).toMatchObject({ userProfileId: "profile-1" });
    expect(licenses.get(idFor("one"))!.holderName).toBeUndefined();
    expect(licenses.get(idFor("one"))!.npn).toBeUndefined();
  });

  it("uses one physical resource id and does nothing at all for deletion", async () => {
    const migrate = vi.fn(async () => ({ copied: 0, skipped: 0 }));
    const created = await handleMigrationEvent({ RequestType: "Create" }, migrate);
    const updated = await handleMigrationEvent({ RequestType: "Update" }, migrate);
    migrate.mockClear();
    const deleted = await handleMigrationEvent({ RequestType: "Delete" }, migrate);
    expect(deleted.PhysicalResourceId).toBe(created.PhysicalResourceId);
    expect(updated.PhysicalResourceId).toBe(created.PhysicalResourceId);
    expect(migrate).not.toHaveBeenCalled();
  });
});
