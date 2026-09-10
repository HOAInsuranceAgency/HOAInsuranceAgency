import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLeadSubmission, type CrmLeadInput } from "../../../web/src/lib/crmLead";
import { buildSchema, graphql } from "graphql";
import { contractReady, probe, waitForContract } from "../../../web/scripts/wait-for-intake-contract.mjs";
const input: CrmLeadInput = { name: "Willow HOA", source: "quote", contactEmail: "prospect@example.com" };
beforeEach(() => sessionStorage.clear());
describe("website intake retry identity", () => {
  it("reuses identity across a lost response and a reload with unchanged answers", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("Lost response")).mockResolvedValue({ accountId: "a1", uploadToken: "token" });
    await expect(createLeadSubmission(send).submit(input)).rejects.toThrow("Lost");
    const result = await createLeadSubmission(send).submit(input);
    expect(result.accountId).toBe("a1"); expect(send.mock.calls[1][1]).toEqual(send.mock.calls[0][1]);
  });
  it("gives corrected answers a fresh identity after a failed submit, including a reload", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("Failed")).mockResolvedValue({ accountId: "a2", uploadToken: null });
    await expect(createLeadSubmission(send).submit(input)).rejects.toThrow("Failed");
    await createLeadSubmission(send).submit({ ...input, name: "Corrected HOA" });
    expect(send.mock.calls[1][1].submissionId).not.toBe(send.mock.calls[0][1].submissionId);
  });
  it("coalesces double clicks but does not return an old receipt for changed answers", async () => {
    const send = vi.fn().mockResolvedValue({ accountId: "a1", uploadToken: null }); const form = createLeadSubmission(send);
    await Promise.all([form.submit(input), form.submit(input)]); expect(send).toHaveBeenCalledTimes(1);
    await form.submit({ ...input, name: "Different enquiry" }); expect(send).toHaveBeenCalledTimes(2);
  });
});
describe("independent app deployment", () => {
  it("rejects the old schema and validates the additive schema without executing intake", async () => {
    const send = vi.fn();
    const schema = (args: string) => buildSchema(`type Query { ready: Boolean } type Mutation { submitWebLead(name: String!${args}): String }`);
    const old = await graphql({ schema: schema(""), source: probe, rootValue: { submitWebLead: send } });
    expect(old.errors?.length).toBeGreaterThan(0);
    const compatible = await graphql({ schema: schema(", submissionId: String, retryProof: String, answerSnapshot: String, attribution: String"), source: probe, rootValue: { submitWebLead: send } });
    expect(compatible.errors).toBeUndefined(); expect(send).not.toHaveBeenCalled();
  });
  it("keeps the website build blocked on validation errors or an unavailable backend", async () => {
    const request = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ message: "Unknown argument" }] }))).mockResolvedValueOnce(new Response("Unavailable", { status: 503 })).mockResolvedValueOnce(new Response(JSON.stringify({ data: {} }))).mockResolvedValueOnce(new Response(JSON.stringify({ data: { leadIntakeReady: JSON.stringify({ ready: true, contractVersion: 2 }) } })));
    expect(await contractReady("https://example.test/graphql", "public-key", request)).toBe(false);
    expect(await contractReady("https://example.test/graphql", "public-key", request)).toBe(false);
    expect(await contractReady("https://example.test/graphql", "public-key", request)).toBe(true);
  });
  it("waits for the new handler even after its schema appears", async () => {
    const request = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: {} }))).mockResolvedValueOnce(new Response(JSON.stringify({ data: { leadIntakeReady: { ready: false, contractVersion: 1 } } })));
    expect(await contractReady("https://example.test/graphql", "public-key", request)).toBe(false);
  });
});


it("ends the deployment probe before the hosting build's 30-minute default", async () => {
  vi.useFakeTimers(); vi.stubEnv("PUBLIC_CRM_API_URL", "https://example.test/graphql"); vi.stubEnv("PUBLIC_CRM_API_KEY", "test-key");
  vi.stubGlobal("fetch", vi.fn(async () => new Response("Unavailable", { status: 503 })));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const waiting = waitForContract(); const result = expect(waiting).rejects.toThrow("CRM intake contract did not become available");
    await vi.advanceTimersByTimeAsync(20 * 60000); await result;
    expect(fetch).toHaveBeenCalledTimes(40);
  } finally { log.mockRestore(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); }
});
