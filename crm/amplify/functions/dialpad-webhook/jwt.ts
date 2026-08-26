import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifying a Dialpad webhook: the whole of this endpoint's authentication.
 *
 * Dialpad delivers events as a JWT signed HS256 with a secret shared at
 * subscription time, and the body of the request IS the token — not JSON with
 * a signature in a header, the way Stripe does it. That difference is the
 * reason this module exists rather than a call to a library, and it is worth
 * being precise about why.
 *
 * ── The algorithm is pinned, not read ──────────────────────────────────
 * A JWT names its own algorithm, in a header the sender controls. A verifier
 * that trusts that field accepts `{"alg":"none"}` with an empty signature,
 * and — with an HMAC secret — accepts a token signed under an asymmetric
 * algorithm whose "public key" is the secret. Both are the classic JWT
 * failures and both turn this endpoint into an unauthenticated public write.
 *
 * So `alg` here is not configuration passed to a verifier. It is a value that
 * must equal `HS256` before anything else happens, and the signature is
 * computed one way only.
 *
 * ── Nothing is parsed before it is verified ────────────────────────────
 * The claims are decoded only after the signature matches, in that order,
 * which is the same discipline `stripe-webhook`'s handler describes: the
 * check IS the authentication, so nothing downstream sees attacker-controlled
 * JSON until it has passed.
 *
 * No JWT dependency, following `magic-link/token.ts`: HS256 is one HMAC and a
 * constant-time compare, and a library here would be a bundle and a config
 * surface for something with no options worth having.
 */

const b64urlToBuffer = (s: string): Buffer =>
  Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

const b64url = (buf: Buffer) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Why a token was refused. Logged, never returned to the caller. */
export type JwtFailure =
  | "malformed"
  | "unsupported-algorithm"
  | "bad-signature"
  | "expired"
  | "bad-claims";

export type JwtResult =
  | { ok: true; claims: Record<string, unknown> }
  | { ok: false; reason: JwtFailure };

/**
 * Verify a compact HS256 JWT and return its claims.
 *
 * `clockMs` is injectable so the expiry branch is testable without waiting;
 * it is not a parameter any caller should pass in production.
 */
export function verifyDialpadJwt(
  token: string,
  secret: string,
  clockMs: number = Date.now()
): JwtResult {
  if (!token || !secret) return { ok: false, reason: "malformed" };

  const parts = token.trim().split(".");
  // Exactly three. A two-part token is the `alg: none` shape, and refusing it
  // on structure means the algorithm check below is never even reached by it.
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [encodedHeader, encodedPayload, signature] = parts;
  if (!encodedHeader || !encodedPayload || !signature) {
    return { ok: false, reason: "malformed" };
  }

  let header: { alg?: unknown; typ?: unknown };
  try {
    header = JSON.parse(b64urlToBuffer(encodedHeader).toString("utf8")) as typeof header;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  // The pin. Not a default, not a list, not configuration.
  if (header.alg !== "HS256") return { ok: false, reason: "unsupported-algorithm" };

  const expected = b64url(
    createHmac("sha256", secret).update(`${encodedHeader}.${encodedPayload}`).digest()
  );
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  // Length is compared first because timingSafeEqual throws on a mismatch,
  // and a thrown verifier is a verifier that did not say no.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad-signature" };
  }

  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(b64urlToBuffer(encodedPayload).toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return { ok: false, reason: "bad-claims" };
  }
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) {
    return { ok: false, reason: "bad-claims" };
  }

  // Honoured when present, not required. Dialpad does not commit to sending
  // `exp`, and demanding one would reject every valid event if they stop.
  const { exp } = claims as { exp?: unknown };
  if (typeof exp === "number" && Number.isFinite(exp) && exp * 1000 <= clockMs) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, claims };
}

/**
 * Sign one, for tests and for the fixture replay harness W1 needs if staging
 * has no Dialpad office of its own.
 *
 * Exported deliberately: a verifier tested only against tokens it minted
 * itself proves very little, so the tests use this to build VALID tokens and
 * then tamper with them by hand.
 */
export function signDialpadJwt(
  claims: Record<string, unknown>,
  secret: string
): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = b64url(Buffer.from(JSON.stringify(claims)));
  const signature = b64url(
    createHmac("sha256", secret).update(`${header}.${payload}`).digest()
  );
  return `${header}.${payload}.${signature}`;
}
