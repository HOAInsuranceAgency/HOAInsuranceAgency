# HOA Insurance Agency

Monorepo for HOA Insurance Agency ([protectmyhoa.com](https://www.protectmyhoa.com)).

| App | Path | Stack | Amplify app |
| --- | --- | --- | --- |
| Marketing site | [`web/`](web) | Astro (static) + React islands | Web (no backend) |
| CRM | [`crm/`](crm) | Vite + React SPA, Amplify Gen 2 (Cognito, AppSync/DynamoDB, S3, Lambda/Textract) | CRM (full-stack) |

Both apps deploy from this repo as separate AWS Amplify apps using the
monorepo build spec in [`amplify.yml`](amplify.yml). Each Amplify app sets
`AMPLIFY_MONOREPO_APP_ROOT` to `web` or `crm`.

## Branches

- `main` — production
- `staging` — pre-production; both Amplify apps build this branch. Land work
  here first, verify on the staging URLs, then merge to `main`.

## Development

```sh
# Marketing site
cd web && npm install && npm run dev

# CRM (frontend + a personal cloud sandbox backend)
cd crm && npm install
npx ampx sandbox        # deploys an isolated dev backend, writes amplify_outputs.json
npm run dev             # in a second terminal
```

See [`crm/README.md`](crm/README.md) for CRM architecture and data model notes.

## Marketing articles

The marketing site owns a native Astro collection at `web/src/content/articles/`.
It starts empty; no demonstration insurance articles are published. `/blog/`
uses the existing site layout and links to current coverage and contact pages.
Published article routes are `/blog/<slug>/`, including the canonical trailing slash.

Add one flat `<slug>.md` file with strict frontmatter matching
`web/src/lib/article-schema.ts`: slug, title, description, topic, tags, an ISO
`publishedAt` timestamp with a timezone, `draft`, image metadata, and supporting
sources. `draft` defaults to `true`. An optional `updatedAt` records a real
revision and must not precede publication. The byline is the agency; this does
not grant permission to claim individual authorship or qualifications.

Public articles require 1,000–2,000 body words. Use level-two or deeper headings
and ordinary Markdown prose with HTTPS citations and site-relative internal
links. Raw HTML, executable components/imports/exports, inline images, and unsafe
link protocols fail the build. Put each image under
`web/public/images/blog/<slug>/`; provide accurate dimensions, alternative text,
visible credit and documented provenance/reuse rights. Image dimensions and
local file existence are checked. Research, professional review and permission
checks remain editorial responsibilities; schema validation cannot verify claims.

Draft and future-dated entries have no generated route, listing link or sitemap
entry. A future timestamp does not schedule a release: publication needs a new
reviewed build when due. This change adds no calendar or publishing service.
A production build fails on malformed content. During local development a
failed content reload clears the article store and logs the error.

Run `npm run articles:test`, `npm run articles:build-test`, `npm run typecheck`
and `npm run build` from `web/`. The build tests copy the site to a temporary
directory and use synthetic content there, without publishing fixture articles
or calling a backend. Review `npm run seo:check` against the checked-in SEO
baseline. Keep the staging-first deployment and CRM intake-contract gate above.
