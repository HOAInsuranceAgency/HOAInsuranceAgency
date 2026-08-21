import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The four things Greptile's review of the merged-to-main work found, asserted
 * so they cannot come back.
 *
 * These read source rather than calling code because every one of them is a
 * property of a *declaration* — an auth rule, a signed header, a GraphQL type,
 * a CDK setting. There is no function to invoke that would tell you whether the
 * presign constrains the body; there is only whether `ContentLength` is in it.
 */

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

const SCHEMA = read("../../amplify/data/resource.ts");
const BACKEND = read("../../amplify/backend.ts");
const LEAD_UPLOAD = read("../../amplify/functions/lead-upload/handler.ts");
const PORTAL = read("../../amplify/functions/upload-portal/handler.ts");
const CRM_LEAD = read("../../../web/src/lib/crmLead.ts");
const PORTAL_CLIENT = read("../../../web/src/lib/uploadPortal.ts");

describe("presigned uploads cannot exceed the size they declared", () => {
  /**
   * The bug: `rejectUpload` checked a caller-supplied `sizeBytes` and then
   * signed a URL that constrained nothing, so a public caller declared a
   * kilobyte and PUT five gigabytes into the documents bucket.
   *
   * `ContentLength` on the command puts `content-length` into
   * X-Amz-SignedHeaders, so a body of any other length fails the signature.
   */
  it("signs the content length into both presigned PUTs", () => {
    for (const [name, src] of [
      ["lead-upload", LEAD_UPLOAD],
      ["upload-portal", PORTAL],
    ] as const) {
      const put = /new PutObjectCommand\(\{([\s\S]*?)\}\)/.exec(src)?.[1];
      expect(put, `${name}: no PutObjectCommand found`).toBeDefined();
      expect(put, name).toContain("ContentLength");
    }
  });

  it("refuses a request that declares no size, since there is nothing to sign", () => {
    for (const [name, src] of [
      ["lead-upload", LEAD_UPLOAD],
      ["upload-portal", PORTAL],
    ] as const) {
      expect(src, name).toMatch(/Number\.isInteger\(sizeBytes\)/);
    }
  });

  it("requires sizeBytes on both upload mutations", () => {
    // Scoped to the mutations. `Document.sizeBytes` is a column and is
    // correctly optional — a staff upload records what it happens to know.
    for (const field of ["requestLeadUpload", "requestPortalUpload"]) {
      const at = SCHEMA.indexOf(`    ${field}: a`);
      expect(at, field).toBeGreaterThan(-1);
      const args = SCHEMA.slice(at, SCHEMA.indexOf(".returns(", at));
      expect(args, field).toMatch(/sizeBytes: a\.integer\(\)\.required\(\)/);
    }
  });

  /**
   * A nullable variable cannot feed a non-null argument: AppSync rejects the
   * whole query at validation. Making the schema strict without these would
   * have broken every upload rather than securing it.
   */
  it("declares the variable non-null in both web clients", () => {
    for (const [name, src] of [
      ["crmLead", CRM_LEAD],
      ["uploadPortal", PORTAL_CLIENT],
    ] as const) {
      expect(src, name).toContain("$sizeBytes: Int!");
      expect(src, name).not.toMatch(/\$sizeBytes: Int\b(?!!)/);
    }
  });
});

describe("upload quotas hold under concurrency", () => {
  /**
   * The bug: read the count, compare, create, write count-plus-one. Two
   * requests on one token both read the same below-limit value and both
   * proceed, so more files land than the ceiling allows and the stored counter
   * ends up lower than the number accepted.
   */
  it("takes the slot with a conditional update, not a read-then-write", () => {
    const quota = read("../../amplify/functions/uploadQuota.ts");
    expect(quota).toContain("ConditionExpression");
    expect(quota).toContain("uploadCount < :max");
    expect(quota).toContain("ConditionalCheckFailedException");
  });

  it("uses it in both public upload handlers", () => {
    for (const [name, src] of [
      ["lead-upload", LEAD_UPLOAD],
      ["upload-portal", PORTAL],
    ] as const) {
      expect(src, name).toContain("reserveUploadSlot");
    }
  });

  it("never writes the count back through the data client", () => {
    // Passing a value read before the atomic increment would undo it.
    for (const [name, src] of [
      ["lead-upload", LEAD_UPLOAD],
      ["upload-portal", PORTAL],
    ] as const) {
      expect(src, name).not.toMatch(/^\s+uploadCount,$/m);
      expect(src, name).not.toMatch(/uploadCount = \(.*\?\? 0\) \+ 1/);
    }
  });

  it("grants both handlers their table, which allow.resource does not", () => {
    expect(BACKEND).toContain("LEAD_REPLY_TABLE");
    expect(BACKEND).toContain("UPLOAD_PORTAL_TABLE");
    expect(BACKEND).toMatch(/leadReplyTable\.grantReadWriteData/);
    expect(BACKEND).toMatch(/uploadPortalTable\.grantReadWriteData/);
  });
});

describe("a lead cannot be emailed the same reply twice", () => {
  /**
   * The claim that flips a row to SENDING carries no condition on its current
   * status, so two overlapping passes can both claim it. Amplify's data client
   * cannot express a conditional update, so the overlap is removed instead.
   */
  it("runs one sweep at a time", () => {
    expect(BACKEND).toContain("reservedConcurrentExecutions = 1");
    const block = /for \(const fn of \[([^\]]*)\]\)/.exec(BACKEND)?.[1] ?? "";
    expect(block).toContain("backend.leadReply");
    expect(block).toContain("backend.portalSweep");
  });

  it("does not claim the comment guarantees something it does not", () => {
    // An earlier comment said flipping to SENDING "is what stops two sweeps
    // emailing the same person twice". It is not, and a comment asserting a
    // guarantee the code lacks is what makes a reviewer skim the line.
    const handler = read("../../amplify/functions/lead-reply/handler.ts");
    expect(handler).toContain("does NOT make a double send impossible");
  });
});

describe("bearer upload tokens are not readable by ordinary users", () => {
  /**
   * `uploadToken` and `token` are the entire authorization for the public
   * upload mutations. Readable by every authenticated user they were pure
   * surface — staff can already write Documents to any account — but they
   * become a real escalation the moment PRODUCER is scoped to its own accounts.
   */
  /**
   * The model's authorization block, taken as the text between `.authorization(`
   * and the end of that model's definition. Matching to the first `])` does not
   * work: the first one is the closing of `["ADMIN"]`.
   */
  const authAfter = (model: string): string => {
    const at = SCHEMA.indexOf(`    ${model}: a`);
    expect(at, `${model} not found`).toBeGreaterThan(-1);
    const authAt = SCHEMA.indexOf(".authorization(", at);
    expect(authAt, `${model} has no authorization block`).toBeGreaterThan(-1);
    return SCHEMA.slice(authAt, SCHEMA.indexOf("\n\n", authAt));
  };

  it("keeps LeadReply and UploadPortal to ADMIN", () => {
    for (const model of ["LeadReply", "UploadPortal"]) {
      const rule = authAfter(model);
      expect(rule, model).toContain('allow.groups(["ADMIN"])');
      expect(rule, model).not.toContain("allow.authenticated()");
    }
  });

  it("leaves no UI depending on that access", () => {
    /**
     * Tightening a model rule breaks its readers at runtime, not at compile
     * time — the generated client types are identical either way. So this walks
     * the app source and asserts nothing reads them, which is what made the
     * change safe to begin with.
     */
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) {
          const body = readFileSync(full, "utf8");
          if (/models\.(LeadReply|UploadPortal)\b/.test(body)) offenders.push(full);
        }
      }
    };
    walk(resolve(process.cwd(), "src"));
    expect(offenders).toEqual([]);
  });
});

/**
 * The Stripe link and the invoice must agree about the amount.
 *
 * Source-read for the same reason as the rest of this file: the behaviour is a
 * property of `ensurePaymentLink`'s control flow, which cannot be invoked
 * without a Stripe client and a data client.
 */
describe("an edited invoice cannot charge its old total", () => {
  const SEND = read("../../amplify/functions/send-invoice/handler.ts");

  it("reuses a generated link only when it still bills the same amount", () => {
    expect(SEND).toContain("stripeLinkAmountCents === wantedCents");
  });

  it("does not return early on the URL alone", () => {
    // The bug: `if (invoice.paymentUrl?.trim()) return ...` handed back a link
    // whose fixed Price was minted for the total before the lines were edited,
    // so the email showed one number and the button charged another.
    expect(SEND).not.toMatch(/if \(invoice\.paymentUrl\?\.trim\(\)\) return/);
  });

  it("replaces a URL that is not one of ours", () => {
    // It used to be honoured outright, on the reasoning that an explicit human
    // choice outranks a generated one. It does not: nothing knows what such a
    // link charges, and the webhook that moves this row to PAID only hears
    // about payments Stripe took — so a link outside that loop is a bill
    // nobody can tell has been paid. The override is gone from the UI, and
    // this is what stops it being honoured for rows that still carry one.
    expect(SEND).not.toContain("if (existingUrl && !existingLinkId) return existingUrl");
    expect(SEND).toMatch(/replacing a hand-set payment link/);
  });

  it("deactivates the superseded link before minting its replacement", () => {
    expect(SEND).toContain("active: false");
  });

  it("records what the link bills, so the next send can compare", () => {
    expect(SEND).toContain("stripeLinkAmountCents: wantedCents");
  });
});

/**
 * Who an invoice reaches.
 *
 * Source-read, like the rest of this file: the behaviour lives in
 * `send-invoice`'s control flow, which needs SES, Stripe and a data client to
 * invoke. What is asserted is the part that silently loses mail if it regresses.
 */
describe("an invoice can go to several people", () => {
  const SEND = read("../../amplify/functions/send-invoice/handler.ts");

  it("splits the argument rather than treating it as one address", () => {
    expect(SEND).toMatch(/\.split\(","\)/);
  });

  it("rejects the whole send if any address is malformed", () => {
    // Dropping the bad one and sending to the rest is the failure that gets
    // noticed a month later, by the person who never got the bill.
    expect(SEND).toMatch(/!to\.every\(\(a\) => EMAIL_RE\.test\(a\)\)/);
  });

  it("puts every recipient on the envelope, not just the first", () => {
    expect(SEND).toContain("ToAddresses: to,");
    expect(SEND).not.toContain("ToAddresses: [to]");
  });

  it("still bccs the agency unless the mail is already going there", () => {
    expect(SEND).toMatch(/to\.some\(\(a\) => a\.toLowerCase\(\) === MAILBOX\.toLowerCase\(\)\)/);
    expect(SEND).toContain("BccAddresses: [MAILBOX]");
  });

  it("records all of them on the invoice", () => {
    // `sentTo` is what the editor shows as "last sent to". One address out of
    // three would be a quiet lie about who has the bill.
    expect(SEND).toMatch(/sentTo: to\.join\(/);
  });
});
