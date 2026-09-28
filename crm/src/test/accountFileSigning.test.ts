import { expect, it } from "vitest";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { fileClient, fileSigningOptions } from "../../amplify/functions/crm-access/file-signing";
it("signs browser uploads without an empty-body checksum and binds their length/type", async () => {
  // Local signing only: explicit fake credentials prevent credential discovery
  // and no AWS request is made by getSignedUrl.
  const client = fileClient({ region: "us-east-1", credentials: { accessKeyId: "test", secretAccessKey: "test" } });
  const signed = new URL(await getSignedUrl(client, new PutObjectCommand({ Bucket: "test", Key: "file.pdf", ContentType: "application/pdf", ContentLength: 25 }), fileSigningOptions));
  expect(signed.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
  expect(signed.searchParams.get("X-Amz-Expires")).toBe("60");
  expect([...signed.searchParams.keys()].some(key => key.includes("checksum"))).toBe(false);
});
