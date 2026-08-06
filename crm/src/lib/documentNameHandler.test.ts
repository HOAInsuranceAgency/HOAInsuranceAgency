import type { S3Event } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The auto-namer, as the Textract Lambda actually runs it.
 *
 * `withExtension` is unit-tested next door; what is worth pinning here is the
 * wiring around the model call, because every one of these is a way to make
 * the pipeline worse than it was before naming existed:
 *
 *  - a naming failure must not undo a successful extraction,
 *  - a producer who renamed the row while Textract ground through a 200-page
 *    condo packet must not be overruled minutes later,
 *  - "I can't tell what this is" must leave the uploaded filename alone
 *    rather than inventing something.
 */

const textract = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-textract", () => ({
  TextractClient: class {
    send = textract.send;
  },
  StartDocumentAnalysisCommand: class {
    constructor(public input: unknown) {}
  },
  GetDocumentAnalysisCommand: class {
    constructor(public input: unknown) {}
  },
}));

const anthropic = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = anthropic;
  },
}));

const models = vi.hoisted(() => ({
  Document: { get: vi.fn(), update: vi.fn() },
}));
vi.mock("aws-amplify/data", () => ({ generateClient: () => ({ models }) }));
vi.mock("aws-amplify", () => ({ Amplify: { configure: vi.fn() } }));
vi.mock("@aws-amplify/backend/function/runtime", () => ({
  getAmplifyDataClientConfig: async () => ({
    resourceConfig: {},
    libraryOptions: {},
  }),
}));

import { handler } from "../../amplify/functions/process-document/handler";

const KEY = "documents/ACCOUNT/acct-1/doc-1/scan_0043.pdf";
const OCR_TEXT =
  "ANNUAL OPERATING BUDGET 2024 WILLOW CREEK HOMEOWNERS ASSOCIATION";

const event = {
  Records: [
    {
      s3: { bucket: { name: "crm-docs" }, object: { key: KEY } },
    },
  ],
} as S3Event;

/** A Textract job that starts, then succeeds with one page of one line. */
function textractSucceeds() {
  textract.send
    .mockResolvedValueOnce({ JobId: "job-1" })
    .mockResolvedValueOnce({
      JobStatus: "SUCCEEDED",
      Blocks: [{ BlockType: "PAGE" }, { BlockType: "LINE", Text: OCR_TEXT }],
    });
}

const says = (text: string) => ({
  stop_reason: "end_turn",
  content: [{ type: "text", text }],
});

/** The `update` call that carried a `name`, if any. */
const renameCall = () =>
  models.Document.update.mock.calls.find(([arg]) => "name" in arg)?.[0];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  models.Document.update.mockResolvedValue({ errors: undefined });
  models.Document.get.mockResolvedValue({
    data: { id: "doc-1", name: "scan_0043.pdf", category: "BUDGET" },
  });
});

describe("process-document auto-naming", () => {
  it("renames a document whose name is still the uploaded filename", async () => {
    textractSucceeds();
    anthropic.create.mockResolvedValue(says("2024 Operating Budget — Willow Creek HOA"));

    await handler(event, {} as never, () => {});

    expect(renameCall()).toEqual({
      id: "doc-1",
      name: "2024 Operating Budget — Willow Creek HOA.pdf",
      lastWriteBy: "process-document",
    });
  });

  it("shows the model the extracted text, not just the filename", async () => {
    textractSucceeds();
    anthropic.create.mockResolvedValue(says("2024 Operating Budget"));

    await handler(event, {} as never, () => {});

    const prompt = anthropic.create.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain(OCR_TEXT);
    expect(prompt).toContain("budget"); // the category, humanised
  });

  it("leaves a name that was edited by hand while Textract ran", async () => {
    textractSucceeds();
    anthropic.create.mockResolvedValue(says("2024 Operating Budget"));
    models.Document.get.mockResolvedValue({
      data: { id: "doc-1", name: "Budget — as sent by Marla.pdf" },
    });

    await handler(event, {} as never, () => {});

    // Not even asked: a producer who has already named the row has said what
    // they want it called.
    expect(anthropic.create).not.toHaveBeenCalled();
    expect(renameCall()).toBeUndefined();
  });

  it("keeps the uploaded filename when the model can't identify the document", async () => {
    textractSucceeds();
    anthropic.create.mockResolvedValue(says("UNKNOWN"));

    await handler(event, {} as never, () => {});

    expect(renameCall()).toBeUndefined();
  });

  it("still records the extraction when naming fails", async () => {
    textractSucceeds();
    anthropic.create.mockRejectedValue(new Error("429 rate limited"));

    await handler(event, {} as never, () => {});

    // The whole point of the tail placement: a naming outage costs the
    // agency a good name, never a searchable document.
    const statuses = models.Document.update.mock.calls.map(
      ([arg]) => arg.ocrStatus
    );
    expect(statuses).toContain("COMPLETE");
    expect(statuses).not.toContain("FAILED");
    expect(renameCall()).toBeUndefined();
  });

  it("does not name a file type it never OCR'd", async () => {
    await handler(
      {
        Records: [
          {
            s3: {
              bucket: { name: "crm-docs" },
              object: { key: "documents/ACCOUNT/acct-1/doc-2/notes.txt" },
            },
          },
        ],
      } as S3Event,
      {} as never,
      () => {}
    );

    expect(models.Document.update).toHaveBeenCalledWith({
      id: "doc-2",
      ocrStatus: "SKIPPED",
    });
    expect(anthropic.create).not.toHaveBeenCalled();
  });
});
