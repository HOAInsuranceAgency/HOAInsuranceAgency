import assert from "node:assert/strict";
import test from "node:test";
import path, { posix, win32 } from "node:path";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { imageMetadata } from "astro/assets/utils";
import type { LoaderContext } from "astro/loaders";
import { articleLoader, isWithinArticleDirectory, serializedArticleReload } from "../src/lib/article-loader";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("reload transactions serialize reverse-ready results deterministically", async () => {
  const oldReady = deferred();
  const newReady = deferred();
  const oldStarted = deferred();
  const starts: number[] = [];
  const commits: number[] = [];
  let revision = 0;
  const reload = serializedArticleReload(async () => {
    const current = ++revision;
    starts.push(current);
    if (current === 1) { oldStarted.resolve(); await oldReady.promise; }
    else await newReady.promise;
    commits.push(current);
  }, () => assert.fail("No failure expected"));
  const first = reload();
  await oldStarted.promise;
  const second = reload();
  newReady.resolve(); // The newer result would finish before the old one without serialization.
  await Promise.resolve();
  assert.deepEqual(starts, [1]);
  assert.deepEqual(commits, []);
  oldReady.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(commits, [1, 2]);
});

test("failure cleanup is part of the serialized transaction", async () => {
  const failingReady = deferred();
  const firstStarted = deferred();
  const cleanupStarted = deferred();
  const cleanupReady = deferred();
  const events: string[] = [];
  let revision = 0;
  const reload = serializedArticleReload(async () => {
    const current = ++revision;
    events.push(`start-${current}`);
    if (current === 1) { firstStarted.resolve(); await failingReady.promise; }
    events.push(`commit-${current}`);
  }, async () => {
    events.push("clear-start"); cleanupStarted.resolve();
    await cleanupReady.promise;
    events.push("clear-finish");
  });
  const first = reload();
  await firstStarted.promise;
  const second = reload();
  failingReady.reject(new Error("Older validation failed"));
  await cleanupStarted.promise;
  assert.deepEqual(events, ["start-1", "clear-start"]);
  cleanupReady.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["start-1", "clear-start", "clear-finish", "start-2", "commit-2"]);
});

test("resolved path containment follows POSIX and Windows drive/separator rules", () => {
  for (const [paths, root, inside, sibling, outside] of [
    [posix, "/site/public", "/site/public/images/blog/fixture/test.jpg", "/site/public-copy/test.jpg", "/site/secret.jpg"],
    [win32, "C:\\site\\public", "C:\\site\\public\\images\\blog\\fixture\\test.jpg", "C:\\site\\public-copy\\test.jpg", "C:\\site\\secret.jpg"],
  ] as const) {
    assert.equal(isWithinArticleDirectory(root, inside, paths), true);
    assert.equal(isWithinArticleDirectory(root, root, paths), true);
    assert.equal(isWithinArticleDirectory(root, sibling, paths), false);
    assert.equal(isWithinArticleDirectory(root, outside, paths), false);
  }
  assert.equal(isWithinArticleDirectory("C:\\site\\public", "D:\\site\\public\\test.jpg", win32), false);
  assert.equal(isWithinArticleDirectory("\\\\server\\share\\public", "\\\\server\\share\\public\\image.jpg", win32), true);
  assert.equal(isWithinArticleDirectory("\\\\server\\share\\public", "\\\\other\\share\\public\\image.jpg", win32), false);
});

async function loaderHarness() {
  const root = await mkdtemp(path.join(tmpdir(), "hoa-article-loader-"));
  const articles = path.join(root, "src/content/articles");
  const imageRoot = path.join(root, "public/images/blog");
  const image = path.join(imageRoot, "layout-fixture/test.jpg");
  const articleFile = path.join(articles, "layout-fixture.md");
  const sourceImage = fileURLToPath(new URL("../public/images/board-meeting.jpg", import.meta.url));
  const dimensions = await imageMetadata(await readFile(sourceImage));
  await mkdir(articles, { recursive: true });
  await mkdir(path.dirname(image), { recursive: true });
  await cp(sourceImage, image);
  const metadata = {
    slug: "layout-fixture", title: "Synthetic watcher fixture", description: "A synthetic loader test, never published.", topic: "Testing", tags: ["testing"], publishedAt: "2026-01-15T10:00:00Z", draft: false,
    image: { src: "/images/blog/layout-fixture/test.jpg", alt: "Synthetic fixture", width: dimensions.width, height: dimensions.height, credit: "Test fixture", provenance: "Local automated test" },
    sources: [{ title: "Synthetic reference", publisher: "Example", url: "https://example.com/reference", accessedAt: "2026-01-14T12:00:00Z" }],
  };
  const save = (version: string) => writeFile(articleFile, `---\n${JSON.stringify(metadata)}\n---\n\n${"synthetic ".repeat(1100)}${version}`);
  await save("initial");
  type Stored = { id: string; body?: string };
  const records = new Map<string, Stored>();
  const errors: string[] = [];
  const renders: string[] = [];
  const watched: string[] = [];
  const gates: { started: ReturnType<typeof deferred>; release: ReturnType<typeof deferred>; active: boolean }[] = [];
  let listener: ((_event: string, changedPath: string) => Promise<void> | undefined) | undefined;
  const context = {
    config: { root: pathToFileURL(`${root}${path.sep}`) },
    store: { clear: () => records.clear(), set: (record: Stored) => { records.set(record.id, record); return true; } },
    parseData: async ({ data }: { data: Record<string, unknown> }) => data,
    generateDigest: (source: string) => source.length,
    renderMarkdown: async (body: string) => {
      renders.push(body);
      const gate = gates.shift();
      if (gate) { gate.active = true; gate.started.resolve(); await gate.release.promise; }
      return { html: `<p>${body}</p>` };
    },
    logger: { error: (error: string) => errors.push(error) },
    watcher: {
      add: (paths: string[]) => watched.push(...paths),
      on: (_event: string, callback: typeof listener) => { listener = callback; },
    },
  } as unknown as LoaderContext;
  await articleLoader().load(context);
  return {
    root, articles, imageRoot, image, articleFile, sourceImage, records, errors, renders, watched, save,
    gate() { const gate = { started: deferred(), release: deferred(), active: false }; gates.push(gate); return gate; },
    change(changedPath = articleFile) { assert.ok(listener); return listener("change", changedPath); },
    async cleanup() { await rm(root, { recursive: true, force: true }); },
  };
}

test("rapid reloads stay ordered when newer rendering would finish first", async () => {
  const harness = await loaderHarness();
  try {
    await harness.save("older");
    const older = harness.gate();
    const first = harness.change();
    await older.started.promise;
    await harness.save("newest");
    const newest = harness.gate();
    const second = harness.change();
    newest.release.resolve(); // Reverse completion pressure: newer work is ready first.
    assert.equal(newest.active, false, "newer validation must wait for the older transaction");
    older.release.resolve();
    await Promise.all([first, second]);
    assert.equal(newest.active, true);
    assert.match(harness.records.get("layout-fixture")?.body ?? "", /newest$/);
    assert.equal(harness.errors.length, 0);
  } finally { await harness.cleanup(); }
});

test("an older failed reload finishes clearing before newer content is installed", async () => {
  const harness = await loaderHarness();
  try {
    await harness.save("older-failure");
    const older = harness.gate();
    const first = harness.change();
    await older.started.promise;
    await harness.save("newest-success");
    const newest = harness.gate();
    const second = harness.change();
    newest.release.resolve();
    older.release.reject(new Error("Synthetic older render failure"));
    await Promise.all([first, second]);
    assert.match(harness.records.get("layout-fixture")?.body ?? "", /newest-success$/);
    assert.match(harness.errors.join("\n"), /Synthetic older render failure/);
  } finally { await harness.cleanup(); }
});

test("article images trigger the same validation queue and recover without a Markdown edit", async () => {
  const harness = await loaderHarness();
  try {
    assert.deepEqual(harness.watched, [harness.articles + path.sep, harness.imageRoot + path.sep]);
    await rm(harness.image);
    await harness.change(harness.image);
    assert.equal(harness.records.size, 0, "missing image invalidates the collection");
    await cp(harness.sourceImage, harness.image);
    await harness.change(harness.image);
    assert.equal(harness.records.size, 1, "adding the repaired image restores the collection");
    await writeFile(harness.image, "Invalid replacement image");
    await harness.change(harness.image);
    assert.equal(harness.records.size, 0, "replacements must undergo metadata validation");
    const differentDimensions = fileURLToPath(new URL("../public/images/condo-boardroom.jpg", import.meta.url));
    await cp(differentDimensions, harness.image);
    await harness.change(harness.image);
    assert.equal(harness.records.size, 0, "valid image replacements must also match declared dimensions");
    assert.match(harness.errors.at(-1) ?? "", /image dimensions must match/);
    await cp(harness.sourceImage, harness.image);
    await harness.change(harness.image);
    assert.equal(harness.records.size, 1);
    const rendersBefore = harness.renders.length;
    assert.equal(harness.change(path.join(harness.root, "public/images/blog-copy/test.jpg")), undefined);
    assert.equal(harness.renders.length, rendersBefore, "sibling prefixes do not trigger reloads");
  } finally { await harness.cleanup(); }
});
