import { S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
// A presigner has no upload body. The SDK's default optional CRC32 would sign
// the checksum of an empty body and make a real browser upload fail at S3.
export const fileClient = (config: S3ClientConfig = {}) => new S3Client({ ...config, requestChecksumCalculation: "WHEN_REQUIRED" });
export const fileSigningOptions = { expiresIn: 60, signableHeaders: new Set(["content-type", "content-length"]) };
