import { z } from "astro/zod";

export const ARTICLE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const text = (max: number) => z.string().trim().min(1).max(max)
  .refine((value) => !/[<>\u0000-\u001f]/.test(value), "Use plain text without HTML or control characters.");
const httpsUrl = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password;
}, "Use a public HTTPS URL without credentials.");
const timestamp = z.iso.datetime({ offset: true });

/** Strict public metadata; no layout, executable components or arbitrary author claims. */
export const articleSchema = z.object({
  slug: z.string().min(3).max(80).regex(ARTICLE_SLUG),
  title: text(120),
  description: text(160),
  topic: text(60),
  tags: z.array(text(40)).min(1).max(5),
  publishedAt: timestamp,
  updatedAt: timestamp.optional(),
  draft: z.boolean().default(true),
  image: z.object({
    src: z.string().regex(/^\/images\/blog\/[a-z0-9-]+\/[a-z0-9-]+\.(?:webp|jpg|jpeg|png|avif)$/),
    alt: text(240),
    width: z.number().int().min(320).max(6000),
    height: z.number().int().min(180).max(6000),
    credit: text(240),
    provenance: text(500),
    sourceUrl: httpsUrl.optional(),
  }).strict(),
  sources: z.array(z.object({
    title: text(240),
    publisher: text(160),
    url: httpsUrl,
    accessedAt: timestamp,
  }).strict()).min(1).max(30),
}).strict().superRefine((data, ctx) => {
  if (!data.image.src.startsWith(`/images/blog/${data.slug}/`)) {
    ctx.addIssue({ code: "custom", path: ["image", "src"], message: "Keep each article's image under its own slug." });
  }
  if (data.updatedAt && Date.parse(data.updatedAt) < Date.parse(data.publishedAt)) {
    ctx.addIssue({ code: "custom", path: ["updatedAt"], message: "A modification cannot precede publication." });
  }
});

export type ArticleData = z.infer<typeof articleSchema>;
