import { S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
// A presigner has no upload body. The SDK's default optional CRC32 would sign
// the checksum of an empty body and make a real browser upload fail at S3.
export const fileClient = (config: S3ClientConfig = {}) => new S3Client({ ...config, requestChecksumCalculation: "WHEN_REQUIRED" });
export const fileSigningOptions = { expiresIn: 60, signableHeaders: new Set(["content-type", "content-length"]) };

/** A download filename is untrusted even when a browser already cleaned it. */
export function downloadContentDisposition(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") throw new Error("Download filename must be text");
  const clean = new TextDecoder().decode(new TextEncoder().encode(value))
    .replace(/[\x00-\x1f\x7f-\x9f"\\]/g, "").replace(/\//g, "_").trim();
  const filename = Array.from(clean).slice(0, 255).join("") || "download";
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"${filename === fallback ? "" : `; filename*=UTF-8''${encoded}`}`;
}
