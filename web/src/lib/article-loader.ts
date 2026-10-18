import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { relative } from "node:path";
import { parseFrontmatter } from "astro/markdown";
import { imageMetadata } from "astro/assets/utils";
import type { Loader, LoaderContext } from "astro/loaders";
import { articleSchema } from "./article-schema";
import { assertArticleMarkdown, assertArticleHtml, articleWordCount } from "./articles";

/** Native content loader: fail closed before saving any renderable article. */
export function articleLoader(): Loader {
  return {
    name: "protectmyhoa-articles",
    async load(context: LoaderContext) {
      const directory = new URL("./src/content/articles/", context.config.root);
      const publicRoot = new URL("./public/", context.config.root);
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
            !(await realpath(image)).startsWith(`${await realpath(publicRoot)}/`)) {
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
      // Keep local previews in sync without requiring a server restart.
      context.watcher?.on("all", async (_event, path) => {
        if (path.startsWith(fileURLToPath(directory))) {
          try { await sync(); } catch (error) { context.store.clear(); context.logger.error(String(error)); }
        }
      });
    },
  };
}
