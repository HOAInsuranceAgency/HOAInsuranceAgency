import { randomBytes } from "node:crypto";

/**
 * The election link's token: 32 random bytes, base64url. Stored on the PfLoan
 * row (the UploadPortal pattern — the row is the validity, there is nothing to
 * forge and nothing to decode), minted by send-invoice when the email offers
 * financing, looked up by the public election Lambda through the
 * electionToken index.
 *
 * Possession is not authority: the Lambda re-validates the kill switch, the
 * loan's status, and the expiry on every call. The token only names the loan.
 *
 * The TTL is generous because the real gate is the loan still being QUOTED —
 * a quote superseded by payment, cancelled, or re-issued dies regardless of
 * the clock. The clock exists so a link in a forwarded email eventually goes
 * cold on its own.
 */

export const ELECTION_TOKEN_TTL_DAYS = 60;

const b64url = (buf: Buffer) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function mintElectionToken(): string {
  return b64url(randomBytes(32));
}

/** 32 bytes of base64url is 43 chars; refuse anything that isn't shaped so. */
export function looksLikeElectionToken(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v);
}

export function electionExpiry(from: Date): string {
  return new Date(from.getTime() + ELECTION_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}
