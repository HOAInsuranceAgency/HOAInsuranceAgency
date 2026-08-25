import { beforeEach, describe, expect, it, vi } from "vitest";

// ./client calls generateClient() at module scope — stub the generator, not
// the module, so client.ts's real exports stay intact.
const AgencySettings = vi.hoisted(() => ({
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));
vi.mock("aws-amplify/data", () => ({
  generateClient: () => ({ models: { AgencySettings } }),
}));

import {
  AGENCY_SETTINGS_ID,
  loadAgencyIdentifiers,
  saveAgencyIdentifiers,
} from "./agencySettings";

/**
 * The agency identifiers singleton.
 *
 * Two things matter here and neither is obvious from the call sites. A backend
 * that has never had these set must read as blank rather than as a failure, or
 * the sidebar shows an error to every user until an admin visits Settings. And
 * the first save has to *create* — `update` on a missing row does not, so
 * without that branch the very first attempt reports success and stores
 * nothing.
 */

const row = (over: Record<string, unknown> = {}) => ({
  id: AGENCY_SETTINGS_ID,
  agencyNpn: "1234567",
  drlpNpn: "7654321",
  agencyEin: "04-1234567",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  AgencySettings.create.mockImplementation(async (input: Record<string, unknown>) => ({
    data: { ...row(), ...input },
    errors: undefined,
  }));
  AgencySettings.update.mockImplementation(async (input: Record<string, unknown>) => ({
    data: { ...row(), ...input },
    errors: undefined,
  }));
});

describe("loadAgencyIdentifiers", () => {
  it("reads the singleton by its fixed id, not the first of a list", async () => {
    AgencySettings.get.mockResolvedValue({ data: row(), errors: undefined });

    await expect(loadAgencyIdentifiers()).resolves.toEqual({
      agencyNpn: "1234567",
      drlpNpn: "7654321",
      agencyEin: "04-1234567",
    });
    expect(AgencySettings.get).toHaveBeenCalledWith({ id: AGENCY_SETTINGS_ID });
  });

  it("reads a never-written backend as blank, not as an error", async () => {
    AgencySettings.get.mockResolvedValue({ data: null, errors: undefined });

    await expect(loadAgencyIdentifiers()).resolves.toEqual({
      agencyNpn: "",
      drlpNpn: "",
      agencyEin: "",
    });
  });

  it("blanks a row whose fields are null", async () => {
    AgencySettings.get.mockResolvedValue({
      data: row({ agencyNpn: null, drlpNpn: null, agencyEin: null }),
      errors: undefined,
    });

    await expect(loadAgencyIdentifiers()).resolves.toEqual({
      agencyNpn: "",
      drlpNpn: "",
      agencyEin: "",
    });
  });

  it("reports a failed read as null, distinct from an empty one", async () => {
    AgencySettings.get.mockResolvedValue({
      data: null,
      errors: [{ message: "Not authorized" }],
    });

    // Amplify's `errors` do not throw. Dropping them would make a permission
    // failure look exactly like "nobody has set these yet".
    await expect(loadAgencyIdentifiers()).resolves.toBeNull();
  });
});

describe("saveAgencyIdentifiers", () => {
  it("creates the row the first time", async () => {
    AgencySettings.get.mockResolvedValue({ data: null, errors: undefined });

    await saveAgencyIdentifiers(
      { agencyNpn: "111", drlpNpn: "222", agencyEin: "04-1234567" },
      "Dana Reyes"
    );

    expect(AgencySettings.create).toHaveBeenCalledWith({
      id: AGENCY_SETTINGS_ID,
      agencyNpn: "111",
      drlpNpn: "222",
      agencyEin: "04-1234567",
      updatedBy: "Dana Reyes",
    });
    expect(AgencySettings.update).not.toHaveBeenCalled();
  });

  it("updates it afterwards", async () => {
    AgencySettings.get.mockResolvedValue({ data: row(), errors: undefined });

    await saveAgencyIdentifiers(
      { agencyNpn: "999", drlpNpn: "888", agencyEin: "99-9999999" },
      "Dana Reyes"
    );

    expect(AgencySettings.update).toHaveBeenCalledWith({
      id: AGENCY_SETTINGS_ID,
      agencyNpn: "999",
      drlpNpn: "888",
      agencyEin: "99-9999999",
      updatedBy: "Dana Reyes",
    });
    expect(AgencySettings.create).not.toHaveBeenCalled();
  });

  /** These get pasted into carrier portals, where a trailing space matters. */
  it("trims, and stores an all-space value as empty rather than blank text", async () => {
    AgencySettings.get.mockResolvedValue({ data: row(), errors: undefined });

    await saveAgencyIdentifiers(
      { agencyNpn: "  1234567 ", drlpNpn: "   ", agencyEin: " 04-1234567 " },
      "Dana"
    );

    expect(AgencySettings.update).toHaveBeenCalledWith(
      expect.objectContaining({
        agencyNpn: "1234567",
        drlpNpn: null,
        agencyEin: "04-1234567",
      })
    );
  });

  it("throws when the write is refused, so the form cannot say 'Saved.'", async () => {
    AgencySettings.get.mockResolvedValue({ data: row(), errors: undefined });
    AgencySettings.update.mockResolvedValue({
      data: null,
      errors: [{ message: "Not authorized" }],
    });

    await expect(
      saveAgencyIdentifiers({ agencyNpn: "1", drlpNpn: "2", agencyEin: "3" }, "Dana")
    ).rejects.toThrow("Not authorized");
  });
});
