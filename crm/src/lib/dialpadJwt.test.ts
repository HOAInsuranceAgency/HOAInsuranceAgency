import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  signDialpadJwt,
  verifyDialpadJwt,
} from "../../amplify/functions/dialpad-webhook/jwt";

/**
 * The webhook's entire authentication.
 *
 * The URL is unauthenticated at the AWS layer because Dialpad cannot sign
 * SigV4, so every one of these is the difference between a private endpoint
 * and a public write. Valid tokens are minted with the signer and then
 * tampered with, rather than hand-written — a verifier tested only against
 * strings it produced itself proves very little.
 */

const SECRET = "sh-dialpad-webhook-secret";
const b64url = (b: Buffer) =>
  b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (o: unknown) => b64url(Buffer.from(JSON.stringify(o)));

describe("a good token", () => {
  it("verifies and returns its claims", () => {
    const token = signDialpadJwt({ call_id: 42, state: "hangup" }, SECRET);
    const result = verifyDialpadJwt(token, SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims).toMatchObject({ call_id: 42, state: "hangup" });
  });

  it("accepts a token with no exp", () => {
    // Dialpad does not commit to sending one; requiring it would reject every
    // valid event the day they stop.
    expect(verifyDialpadJwt(signDialpadJwt({ a: 1 }, SECRET), SECRET).ok).toBe(true);
  });
});

describe("the algorithm is pinned, not read", () => {
  it("refuses alg: none with an empty signature", () => {
    // The classic. A verifier that trusts the header's own alg accepts this
    // and the endpoint becomes an unauthenticated public write.
    const token = `${enc({ alg: "none", typ: "JWT" })}.${enc({ call_id: 1 })}.`;
    expect(verifyDialpadJwt(token, SECRET)).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses alg: none even when shaped as three parts", () => {
    const token = `${enc({ alg: "none", typ: "JWT" })}.${enc({ call_id: 1 })}.x`;
    expect(verifyDialpadJwt(token, SECRET)).toEqual({
      ok: false,
      reason: "unsupported-algorithm",
    });
  });

  it("refuses an asymmetric algorithm signed with the secret as its key", () => {
    // RS256/HS256 confusion: the attacker signs HMAC with what the verifier
    // holds, and a library configured to "just verify" would accept it.
    const header = enc({ alg: "RS256", typ: "JWT" });
    const payload = enc({ call_id: 1 });
    const sig = b64url(createHmac("sha256", SECRET).update(`${header}.${payload}`).digest());
    expect(verifyDialpadJwt(`${header}.${payload}.${sig}`, SECRET)).toEqual({
      ok: false,
      reason: "unsupported-algorithm",
    });
  });

  it("refuses a lowercase or padded spelling of the algorithm", () => {
    for (const alg of ["hs256", "HS256 ", "Hs256"]) {
      const header = enc({ alg, typ: "JWT" });
      const payload = enc({ call_id: 1 });
      const sig = b64url(createHmac("sha256", SECRET).update(`${header}.${payload}`).digest());
      expect(verifyDialpadJwt(`${header}.${payload}.${sig}`, SECRET).ok, alg).toBe(false);
    }
  });
});

describe("the signature has to be the right one", () => {
  it("refuses a token signed with a different secret", () => {
    const token = signDialpadJwt({ call_id: 1 }, "someone-elses-secret");
    expect(verifyDialpadJwt(token, SECRET)).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("refuses a payload edited after signing", () => {
    const token = signDialpadJwt({ call_id: 1, direction: "inbound" }, SECRET);
    const [header, , sig] = token.split(".");
    const tampered = `${header}.${enc({ call_id: 1, direction: "outbound" })}.${sig}`;
    expect(verifyDialpadJwt(tampered, SECRET)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("refuses a truncated signature instead of throwing", () => {
    // timingSafeEqual throws on a length mismatch, and a verifier that throws
    // is a verifier that did not say no.
    const token = signDialpadJwt({ call_id: 1 }, SECRET);
    const [header, payload, sig] = token.split(".");
    expect(verifyDialpadJwt(`${header}.${payload}.${sig.slice(0, 10)}`, SECRET)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("refuses an empty secret", () => {
    expect(verifyDialpadJwt(signDialpadJwt({ a: 1 }, SECRET), "").ok).toBe(false);
  });
});

describe("malformed input never throws", () => {
  it("returns a refusal for every shape of rubbish", () => {
    for (const bad of ["", "   ", "one.two", "a.b.c.d", "....", "not-a-jwt", "%%%.%%%.%%%"]) {
      expect(() => verifyDialpadJwt(bad, SECRET)).not.toThrow();
      expect(verifyDialpadJwt(bad, SECRET).ok, bad).toBe(false);
    }
  });

  it("refuses claims that are not an object", () => {
    const header = enc({ alg: "HS256", typ: "JWT" });
    for (const payload of [enc([1, 2, 3]), enc("a string"), enc(null)]) {
      const sig = b64url(createHmac("sha256", SECRET).update(`${header}.${payload}`).digest());
      expect(verifyDialpadJwt(`${header}.${payload}.${sig}`, SECRET)).toEqual({
        ok: false,
        reason: "bad-claims",
      });
    }
  });
});

describe("expiry, when it is claimed", () => {
  it("refuses an expired token", () => {
    const token = signDialpadJwt({ exp: 1_000 }, SECRET);
    expect(verifyDialpadJwt(token, SECRET, 2_000_000)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("accepts one that has not expired yet", () => {
    const token = signDialpadJwt({ exp: 3_000 }, SECRET);
    expect(verifyDialpadJwt(token, SECRET, 2_000_000).ok).toBe(true);
  });
});
