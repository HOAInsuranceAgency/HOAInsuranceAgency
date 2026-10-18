import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path, { relative, type PlatformPath } from "node:path";
import { parseFrontmatter } from "astro/markdown";
import { imageMetadata } from "astro/assets/utils";
import type { Loader, LoaderContext } from "astro/loaders";
import { articleSchema } from "./article-schema";
import { assertArticleMarkdown, assertArticleHtml, articleWordCount } from "./articles";

/** Compare resolved paths with their platform's own separator and drive rules. */
export function isWithinArticleDirectory(root: string, candidate: string, paths: Pick<PlatformPath, "relative" | "isAbsolute" | "sep"> = path): boolean {
  const child = paths.relative(root, candidate);
  return !paths.isAbsolute(child) && child !== ".." && !child.startsWith(`..${paths.sep}`);
}

/** A reload transaction includes its failure cleanup before the next can start. */
export function serializedArticleReload(reload: () => Promise<void>, onFailure: (error: unknown) => void | Promise<void>): () => Promise<void> {
  let pending = Promise.resolve();
  return () => {
    const next = pending.then(async () => {
      try { await reload(); } catch (error) { await onFailure(error); }
    });
    // Keep future reloads usable even if an unexpected logging/cleanup error occurs.
    pending = next.catch(() => {});
    return next;
  };
}

/** Native content loader: fail closed before saving any renderable article. */
export function articleLoader(): Loader {
  return {
    name: "protectmyhoa-articles",
    async load(context: LoaderContext) {
      const directory = new URL("./src/content/articles/", context.config.root);
      const publicRoot = new URL("./public/", context.config.root);
      const articleDirectory = fileURLToPath(directory);
      const imageDirectory = fileURLToPath(new URL("./images/blog/", publicRoot));
      const sync = async () => {
        const entries = await readdir(directory, { withFileTypes: true });
        const records = [];
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (entry.name.startsWith(".")) continue;
          if (!entry.isFile() || !entry.name.endsWith(".md")) {
            throw new Error(`Articles must be flat Markdown files: ${entry.name}`);
          }
          const file = new URL(entry.name, directory);
          const source = await readFile(file, "utf8");
          const { frontmatter, content: body } = parseFrontmatter(source);
          const data = articleSchema.parse(frontmatter);
          const id = entry.name.slice(0, -3);
          if (id !== data.slug) throw new Error(`Article filename must match its slug: ${entry.name}`);
          assertArticleMarkdown(body);
          const words = articleWordCount(body);
          if (!data.draft && (words < 1000 || words > 2000)) {
            throw new Error(`${id}: published articles must contain 1,000–2,000 words; found ${words}.`);
          }
          const image = new URL(`.${data.image.src}`, publicRoot);
          const imageStat = await lstat(image);
          if (!imageStat.isFile() || imageStat.size > 10 * 1024 * 1024 ||
            !isWithinArticleDirectory(await realpath(publicRoot), await realpath(image))) {
            throw new Error(`${id}: article images must be local files of at most 10 MB.`);
          }
          const dimensions = await imageMetadata(await readFile(image), data.image.src);
          if (dimensions.width !== data.image.width || dimensions.height !== data.image.height) {
            throw new Error(`${id}: image dimensions must match the file.`);
          }
          const rendered = await context.renderMarkdown(body, { fileURL: file });
          assertArticleHtml(rendered.html);
          const parsedData = await context.parseData({ id, data, filePath: fileURLToPath(file) });
          records.push({ id, data: parsedData, body, rendered, filePath: relative(fileURLToPath(context.config.root), fileURLToPath(file)).split("\\").join("/"), digest: context.generateDigest(source) });
        }
        context.store.clear();
        for (const record of records) context.store.set(record);
      };
      await sync();
      // Serialize validation, store replacement and failure handling together.
      // An older slow/failed reload cannot overwrite or clear a newer result.
      const reload = serializedArticleReload(sync, (error) => {
        context.store.clear();
        context.logger.error(String(error));
      });
      context.watcher?.add([articleDirectory, imageDirectory]);
      context.watcher?.on("all", (_event, changedPath) => {
        if (!isWithinArticleDirectory(articleDirectory, changedPath) &&
          !isWithinArticleDirectory(imageDirectory, changedPath)) return;
        return reload();
      });
    },
  };
}
