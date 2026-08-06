import { describe, expect, it } from "vitest";
import {
  MAX_NAME_CHARS,
  splitExtension,
  withExtension,
} from "../../amplify/functions/process-document/name";

/**
 * `withExtension` is the one rule the rename box and the Lambda's auto-namer
 * both have to obey, so it is tested once here for both. The invariant it
 * exists for is narrow and load-bearing: `FilePreview.canPreview` decides
 * whether the Preview button renders by reading the extension off `name`, so
 * a rename that drops or mangles it removes a button silently.
 */
describe("splitExtension", () => {
  it("splits on the last dot", () => {
    expect(splitExtension("budget.2024.pdf")).toEqual({
      stem: "budget.2024",
      ext: ".pdf",
    });
  });

  it("takes the filename out of a key", () => {
    expect(splitExtension("documents/ACCOUNT/a1/d9/scan_0043.pdf").ext).toBe(
      ".pdf"
    );
  });

  it("treats a leading dot as a hidden file, not an extension", () => {
    expect(splitExtension(".env")).toEqual({ stem: ".env", ext: "" });
  });

  it("treats a trailing dot as no extension", () => {
    expect(splitExtension("draft.")).toEqual({ stem: "draft.", ext: "" });
  });

  it("handles a file with no extension at all", () => {
    expect(splitExtension("LOSSRUNS")).toEqual({ stem: "LOSSRUNS", ext: "" });
  });
});

describe("withExtension", () => {
  it("carries the extension of the stored object, not the typed name", () => {
    expect(withExtension("2024 Operating Budget", "scan_0043.pdf")).toBe(
      "2024 Operating Budget.pdf"
    );
  });

  it("reads the extension out of an S3 key", () => {
    expect(
      withExtension("Loss Runs", "documents/ACCOUNT/a1/d9/IMG_2211.jpeg")
    ).toBe("Loss Runs.jpeg");
  });

  it("does not double an extension the author typed", () => {
    expect(withExtension("Loss Runs.pdf", "scan.pdf")).toBe("Loss Runs.pdf");
  });

  it("matches the extension case-insensitively", () => {
    expect(withExtension("Loss Runs.PDF", "scan.pdf")).toBe("Loss Runs.pdf");
  });

  it("keeps a differing extension as part of the name", () => {
    // Guessing which of the two the author meant would break "Policy v2.1".
    expect(withExtension("Budget.doc", "scan.pdf")).toBe("Budget.doc.pdf");
  });

  it("adds nothing when the object has no extension", () => {
    expect(withExtension("Loss Runs", "LOSSRUNS")).toBe("Loss Runs");
  });

  it("strips the quotes a model wraps its answer in", () => {
    expect(withExtension('"2024 Budget"', "scan.pdf")).toBe("2024 Budget.pdf");
  });

  it("collapses whitespace and drops control characters", () => {
    expect(withExtension("2024\u0000   Budget\n", "scan.pdf")).toBe(
      "2024 Budget.pdf"
    );
  });

  it("neutralises path separators", () => {
    // A name is echoed in plenty of places; none of them should ever be
    // handed something that reads as a path.
    expect(withExtension("../../etc/passwd", "scan.pdf")).toBe(
      "..-..-etc-passwd.pdf"
    );
  });

  it("caps the length", () => {
    const stem = withExtension("A".repeat(200), "scan.pdf");
    expect(stem).toBe("A".repeat(MAX_NAME_CHARS) + ".pdf");
  });

  it("returns null when nothing usable is left", () => {
    // An empty name is not a rename, it is a row that reads as a blank cell.
    expect(withExtension("   ", "scan.pdf")).toBeNull();
    expect(withExtension('"""', "scan.pdf")).toBeNull();
    expect(withExtension(".pdf", "scan.pdf")).toBeNull();
  });
});
