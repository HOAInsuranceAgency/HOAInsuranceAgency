import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ list: vi.fn(), team: vi.fn(), cognito: vi.fn(), liveRoles: vi.fn() }));
vi.mock("../../amplify/functions/communications/data", () => ({ dataClient: async () => ({ models: { UserProfile: { list: h.list } } }) }));
vi.mock("../../amplify/functions/communications/workflow", () => ({ team: h.team }));
vi.mock("@aws-sdk/client-cognito-identity-provider", () => ({ CognitoIdentityProviderClient: class { send = h.cognito; } }));
vi.mock("../../amplify/functions/communications/teamAvailability", () => ({ currentTeamRoles: h.liveRoles }));
import { displayRoster } from "../../amplify/functions/communications/displayRoster";

beforeEach(() => { vi.clearAllMocks(); h.team.mockResolvedValue([]); h.list.mockResolvedValue({ data: [], nextToken: null }); });

it("reads a twenty-member display roster without per-user Cognito or access checks", async () => {
  h.list.mockResolvedValue({ data: Array.from({ length: 20 }, (_, i) => ({ userId: `u${i}`, firstName: "Current", lastName: `${i}`, email: `u${i}@example.com`, role: "PRODUCER" })) });
  h.team.mockResolvedValue(Array.from({ length: 20 }, (_, i) => ({ userId: `u${i}`, name: "Older name", enabled: true, salesperson: true, version: 3 })));
  const members = await displayRoster();
  expect(members).toHaveLength(20);
  expect(members[0]).toMatchObject({ userId: "u0", name: "Current 0", email: "u0@example.com", version: 3, salesperson: true, available: true });
  expect(h.list).toHaveBeenCalledExactlyOnceWith({ nextToken: undefined, limit: 100, selectionSet: ["userId", "firstName", "lastName", "email"] });
  expect(h.team).toHaveBeenCalledTimes(1);
  expect(h.cognito).not.toHaveBeenCalled();
  expect(h.liveRoles).not.toHaveBeenCalled();
});

it("keeps missing or disabled eligibility nonassignable and ignores editable profile roles", async () => {
  h.list.mockResolvedValue({ data: [
    { userId: "missing", firstName: "New", lastName: "Member", email: "new@example.com", role: "PRODUCER" },
    { userId: "disabled", firstName: "Disabled", lastName: "Member", email: "disabled@example.com" },
  ] });
  h.team.mockResolvedValue([{ userId: "disabled", enabled: false, available: true, salesperson: true, champion: true }]);
  const result = await displayRoster();
  expect(result[0]).toMatchObject({ userId: "missing", enabled: false, available: false, salesperson: false });
  expect(result[1]).toMatchObject({ userId: "disabled", enabled: false, available: false });
  expect(result[1]).not.toHaveProperty("champion");
});

it("starts profile and materialized snapshot reads together and drains profile pages", async () => {
  let finishTeam!: (value: unknown) => void;
  h.team.mockImplementation(() => new Promise(resolve => { finishTeam = resolve; }));
  h.list.mockResolvedValueOnce({ data: [{ userId: "a", email: "a@example.com" }], nextToken: "more" }).mockResolvedValueOnce({ data: [{ userId: "b", email: "b@example.com" }], nextToken: null });
  const pending = displayRoster();
  await vi.waitFor(() => expect(h.list).toHaveBeenCalledTimes(2));
  expect(h.team).toHaveBeenCalledTimes(1);
  finishTeam([]);
  expect((await pending).map(member => member.userId)).toEqual(["a", "b"]);
  expect(h.list.mock.calls[1][0].nextToken).toBe("more");
});

it("does not conceal failed or nonadvancing profile reads as a complete roster", async () => {
  h.list.mockResolvedValueOnce({ data: [], errors: [{ message: "Denied" }] });
  await expect(displayRoster()).rejects.toThrow("Could not load teammates");
  h.list.mockResolvedValue({ data: [], nextToken: "same" });
  await expect(displayRoster()).rejects.toThrow("finish loading");
});
