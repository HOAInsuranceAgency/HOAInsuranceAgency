import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import { reviewedStateSlugs } from "./src/data/states.ts";
import { isNoindexRoute } from "./src/data/routes.ts";

/** Keep generic, unreviewed state pages out of the sitemap. */
const isUnreviewedStatePage = (page) => {
  const m = page.match(/\/hoa-insurance-([a-z-]+)\/?$/);
  if (!m) return false;
  const slug = m[1];
  // City pages are /hoa-insurance-{city}-{st} and always end in a two-letter
  // segment; no state slug does ("north-carolina" ends in 8 letters). They stay.
  if (/-[a-z]{2}$/.test(slug)) return false;
  return !reviewedStateSlugs.includes(slug);
};

export default defineConfig({
  /** Paired with `AGENCY.site`; the test suite enforces equality. */
  site: "https://www.protectmyhoa.com",
  /** Match the canonical and CDN trailing-slash contract. */
  trailingSlash: "always",
  /** Preserve HTML-aware inline spacing across the Astro 7 migration. */
  compressHTML: true,
  /** Compatibility route for the retired Squarespace `/home` URL. */
  redirects: {
    "/home": "/",
  },
  integrations: [
    react(),
    sitemap({
      /** Include only canonical, indexable routes. */
      filter: (page) => !isNoindexRoute(page) && !isUnreviewedStatePage(page),
    }),
  ],
  output: "static",
});
