import { defineCollection } from "astro:content";
import { articleLoader } from "./lib/article-loader";
import { articleSchema } from "./lib/article-schema";

export const collections = {
  articles: defineCollection({ loader: articleLoader(), schema: articleSchema }),
};
