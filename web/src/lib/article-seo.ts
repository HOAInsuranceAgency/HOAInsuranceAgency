import { canonicalUrl, absoluteUrl, ORG_ID } from "./seo";
import { articlePath, articleWordCount, type Article } from "./articles";

export function articleSchemaNode(article: Article): Record<string, unknown> {
  const { data } = article;
  const canonical = canonicalUrl(articlePath(data.slug));
  return {
    "@type": "BlogPosting",
    "@id": `${canonical}#article`,
    mainEntityOfPage: { "@id": `${canonical}#webpage` },
    url: canonical,
    headline: data.title,
    description: data.description,
    datePublished: data.publishedAt,
    ...(data.updatedAt ? { dateModified: data.updatedAt } : {}),
    author: { "@id": ORG_ID },
    publisher: { "@id": ORG_ID },
    image: { "@type": "ImageObject", url: absoluteUrl(data.image.src), width: data.image.width, height: data.image.height, caption: data.image.alt, creditText: data.image.credit },
    articleSection: data.topic,
    keywords: data.tags.join(", "),
    inLanguage: "en-US",
    citation: data.sources.map((source) => source.url),
    wordCount: articleWordCount(article.body ?? ""),
  };
}
