import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://www.protectmyhoa.com",
  integrations: [
    react(),
    sitemap({
      // Exclude private association pages from the public sitemap.
      // These are PM-distributed links, not organic SEO targets.
      filter: (page) => !page.includes("/associations/"),
    }),
  ],
  output: "static",
});
