import { expect, it } from "vitest";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { downloadContentDisposition, fileClient, fileSigningOptions } from "../../amplify/functions/crm-access/file-signing";
it("signs browser uploads without an empty-body checksum and binds their length/type", async () => {
  // Local signing only: explicit fake credentials prevent credential discovery
  // and no AWS request is made by getSignedUrl.
  const client = fileClient({ region: "us-east-1", credentials: { accessKeyId: "test", secretAccessKey: "test" } });
  const signed = new URL(await getSignedUrl(client, new PutObjectCommand({ Bucket: "test", Key: "file.pdf", ContentType: "application/pdf", ContentLength: 25 }), fileSigningOptions));
  expect(signed.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
  expect(signed.searchParams.get("X-Amz-Expires")).toBe("60");
  expect([...signed.searchParams.keys()].some(key => key.includes("checksum"))).toBe(false);
});
it("binds the requested attachment filename into the signed GET URL", async () => {
  const client = fileClient({ region: "us-east-1", credentials: { accessKeyId: "test", secretAccessKey: "test" } });
  const disposition = downloadContentDisposition("2026 budget.pdf");
  const signed = new URL(await getSignedUrl(client, new GetObjectCommand({ Bucket: "test", Key: "stored-name.pdf", ResponseContentDisposition: disposition }), fileSigningOptions));
  expect(signed.searchParams.get("response-content-disposition")).toBe('attachment; filename="2026 budget.pdf"');
  expect(signed.searchParams.get("X-Amz-Expires")).toBe("60");
});
it("sanitizes control characters and quotes, bounds filenames, and supplies a safe fallback", () => {
  expect(downloadContentDisposition('a"; evil=1\r\n/b\\.pdf\u007f')).toBe('attachment; filename="a; evil=1_b.pdf"');
  expect(downloadContentDisposition('\r\n"\\')).toBe('attachment; filename="download"');
  expect(downloadContentDisposition("a".repeat(300))).toBe(`attachment; filename="${"a".repeat(255)}"`);
  expect(downloadContentDisposition(undefined)).toBeUndefined();
  expect(() => downloadContentDisposition({ filename: "wrong type" })).toThrow("must be text");
});
it("preserves Unicode names using an encoded header parameter and an ASCII fallback", () => {
  expect(downloadContentDisposition("résumé.pdf")).toBe('attachment; filename="r_sum_.pdf"; filename*=UTF-8\'\'r%C3%A9sum%C3%A9.pdf');
  expect(downloadContentDisposition("name\ud800.pdf")).not.toMatch(/[\ud800-\udfff]/);
});
