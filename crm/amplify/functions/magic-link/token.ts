import { createHmac, timingSafeEqual } from "node:crypto";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

/**
 * Magic-link token: `${base64url(payload)}.${base64url(hmacSha256(payload))}`
 * where payload = JSON {email, exp}. Signed with a Secrets Manager secret
 * shared by the create and verify triggers. 15-minute expiry.
 */

export const TOKEN_TTL_MS = 15 * 60 * 1000;

const sm = new SecretsManagerClient();
let cachedSecret: string | undefined;

export async function getSigningSecret(): Promise<string> {
  if (!cachedSecret) {
    const { SecretString } = await sm.send(
      new GetSecretValueCommand({ SecretId: process.env.MAGIC_LINK_SECRET_ARN })
    );
    if (!SecretString) throw new Error("Magic link signing secret is empty");
    cachedSecret = SecretString;
  }
  return cachedSecret;
}

const b64url = (buf: Buffer) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const sign = (payload: string, secret: string) =>
  b64url(createHmac("sha256", secret).update(payload).digest());

export function mintToken(email: string, secret: string): string {
  const payload = b64url(
    Buffer.from(JSON.stringify({ email, exp: Date.now() + TOKEN_TTL_MS }))
  );
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyToken(token: string, email: string, secret: string): boolean {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const expected = sign(payload, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    const parsed = JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()
    ) as { email?: string; exp?: number };
    return (
      typeof parsed.exp === "number" &&
      parsed.exp > Date.now() &&
      typeof parsed.email === "string" &&
      parsed.email.toLowerCase() === email.toLowerCase()
    );
  } catch {
    return false;
  }
}
