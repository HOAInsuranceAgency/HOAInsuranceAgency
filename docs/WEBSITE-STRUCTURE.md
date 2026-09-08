# Website Structure & SEO Reference — protectmyhoa.com

**Purpose:** a pre-edit reference for updating site content **without disturbing the SEO surface that is currently producing organic leads.**

Generated from a full read of `web/` plus a production build (`npm --prefix web run build`) on 2026-08-13.
All page counts, titles, and URLs in this document were extracted from the built `dist/` output — they are what the site actually ships, not what the templates suggest.

> **Revised 2026-08-13.** Three things changed under this document since the 2026-08-06 pass and are now folded in: GA4 was added and the broken conversion tag was fixed (§1), `states.ts` grew from 6 states to all 50 plus DC and the site went from 107 pages to 153 (§3), and `/contact` became a real route (§4). Every figure below was re-measured against a fresh build.

> **Revised 2026-09-07 — the identity & indexing pass.** This is the largest revision the
> document has taken, and most of it is *correction* rather than addition. What moved:
>
> - **Identity.** The site now states, in one place and consistently, that **ProtectMyHOA is a
>   brand of HOA Insurance Agency LLC** rather than an agency of its own. `shared/agency.ts`
>   grew `brandName`, separate founder display/legal/title fields, `foundingDate`, `areaServed`,
>   `description`, and the centrally maintained founder profile list; the
>   NAP table in §9 grew the rows that record them, plus an explicit **Trade name / DBA** row
>   that records the registration status as **NOT VERIFIED**.
> - **Canonicals.** `astro.config.mjs` now sets `trailingSlash: "always"` and every canonical is
>   built by `canonicalUrl()` in the new `web/src/lib/seo.ts`. See §5's *canonical & URL
>   contract* — including the warning that the redirect rules themselves are not in this repo.
> - **Structured data.** Two disconnected `InsuranceAgency` nodes became **one `@graph`**, owned
>   by `web/src/lib/seo.ts` and emitted on applicable public and funnel pages. Private
>   association links deliberately omit agency structured data. §7 is rewritten.
> - **Service area.** The six-state footprint (MA/RI/NH/CT/NY/OK) is **obsolete**. §7 and §9
>   record what it was removed from and what replaced it.
> - **Indexing.** `web/src/data/routes.ts` is now the single source for both the `noindex`
>   decision and the sitemap filter. The sitemap went from **46 URLs to 35** — see §3.
> - **FAQ.** The FAQ configuration this document described no longer exists, and the
>   "rich-result eligible" claim attached to it was wrong on the merits. Both corrected in §7.
>
> Page counts re-measured against a fresh build on 2026-09-07: **155 pages from 14 templates,
> 35 in the sitemap.**

---

## Contents

1. [Read this first — the analytics situation](#1-read-this-first--the-analytics-situation)
2. [Repository layout](#2-repository-layout)
3. [Page inventory](#3-page-inventory)
   - [The single noindex list — `data/routes.ts`](#the-single-noindex-list--dataroutests)
4. [Complete title list](#4-complete-title-list)
5. [Where the SEO lives](#5-where-the-seo-lives)
   - [The canonical / URL contract](#the-canonical--url-contract)
6. [Edit safety classification](#6-edit-safety-classification)
7. [Structured data](#7-structured-data)
   - [Service area — the six-state footprint is obsolete](#service-area--the-six-state-footprint-is-obsolete)
   - [`FAQPage` — what is actually there, and why it is not a rich result](#faqpage--what-is-actually-there-and-why-it-is-not-a-rich-result)
8. [Internal link graph](#8-internal-link-graph)
9. [Agency identity (NAP)](#9-agency-identity-nap)
10. [Forms & lead flow](#10-forms--lead-flow)
11. [Environment variables](#11-environment-variables)
12. [Build & deploy](#12-build--deploy)
13. [Known issues](#13-known-issues)
    - [Known issues / external dependencies](#known-issues--external-dependencies)
14. [Pre-commit verification procedure](#14-pre-commit-verification-procedure)

> **A note on numbering.** New material in this pass was added as *subsections* of the sections
> it belongs to, rather than as new top-level sections. That is deliberate: a dozen places in
> this document and in the code comments refer to "§3", "§7", "§13" and so on, and renumbering
> would silently invalidate every one of them.

---

## 1. Read this first — the analytics situation

Three tags, all declared once in [`web/src/constants.ts`](../web/src/constants.ts) and emitted by one component, [`web/src/components/Analytics.astro`](../web/src/components/Analytics.astro):

| Tag | ID | What it does |
| --- | --- | --- |
| GA4 | `G-VWMS4RWTRX` | Organic + all-channel traffic. **Added 2026-08-11** |
| Google **Ads** (gtag.js) | `AW-18384211768` + `AW-18085022517` | Ad conversion tracking. Both accounts record every lead — **added 2026-08-26** |
| Microsoft Clarity | `wamnker55b` | Session recordings + heatmaps |

GA4 and Google Ads share one library, so `gtag/js` is requested **once** and followed by a `config` call per measurement ID. Two script tags would download the same library twice and race to initialize the same `dataLayer`.

### What changed since the last pass

Both of the analytics problems this section used to record are fixed.

**GA4 now exists.** Before 2026-08-11 the only `gtag.js` account was an `AW-` Ads ID, which reports to Google Ads and not to GA4 — so there was no on-site organic analytics at all and Search Console was the only source. There is now an on-site baseline.

**Conversion tracking fires.** The old snippet was compiled by Astro to `type="module"`, which kept its `gtag` function out of global scope: pageviews still worked, because `config` pushes to the global `window.dataLayer`, but `window.gtag` was never defined and every later call from application code silently did nothing. `Analytics.astro` emits the snippet with `is:inline`, which produces a classic script, so `gtag` is global and `fireConversion()` in `constants.ts` reaches it.

One consequence worth knowing: conversions that were silently dropped before 2026-08-11 will never appear in Ads, so **do not compare conversion volume across that date.** Lead volume is unaffected — the forms always posted to email, the CRM, and Zapier independently of gtag.

### Still true

- ~~`ContactForm.tsx` fires **no** conversion.~~ **No longer true, re-verified 2026-09-07.** All
  five lead surfaces — `ContactForm`, `AssociationLeadForm`, `InstantAssessment`,
  `CoverageCalculator`, `QuoteApp` — now call `trackLead()` from `constants.ts`, which reports to
  GA4 *and* Google Ads. The `send_to` label and the account ids are no longer hand-copied into
  any component or `<head>`. INVENTORY §1.5 is annotated to match.
- The kill switch is on by default; staging must set `PUBLIC_ANALYTICS_DISABLED=true`. See §11.

---

## 2. Repository layout

Monorepo, two independently deployed Amplify apps:

| App | Path | Stack | SEO relevant? |
| --- | --- | --- | --- |
| Marketing site | `web/` | Astro 7.3 static + React islands | **Yes — this is the whole public site** |
| CRM | `crm/` | Vite + React SPA, Amplify Gen 2 (Cognito, AppSync/DynamoDB, S3, Lambda/Textract) | No — authenticated internal tool |
| Shared | `shared/` | Dependency-free constants used by both | Yes — feeds JSON-LD |

Branches: `staging` (pre-production, both apps build it) → `main` (production). Land work on `staging`, verify on the staging URLs, then merge.

### `web/` source tree

```
web/
├── astro.config.mjs            # site URL, sitemap integration + exclusion filter
├── public/
│   ├── robots.txt              # crawl directives
│   ├── favicon.png, logo.png
│   └── images/                 # incl. compressed hero-video.mp4 (~2.15 MB)
├── scripts/
│   └── sync-buildium.ts        # generates data/properties.json
└── src/
    ├── constants.ts            # measurement IDs, analytics switch, conversion fn,
    │                           #   nav links, socials
    ├── lib/
    │   ├── seo.ts              # canonicalUrl() + THE structured-data @graph (§5, §7)
    │   └── crmLead.ts          # web → CRM AppSync write
    ├── layouts/
    │   └── Layout.astro        # THE SEO HEAD — canonical, OG, robots, the @graph
    ├── pages/                  # 14 templates → 155 pages
    ├── components/
    │   ├── Navbar.astro, Footer.astro, Hero.astro, HeroLookup.astro
    │   ├── Analytics.astro     # the ONLY analytics block; all 4 heads import it
    │   ├── CoverageMap.astro   # build-time TopoJSON map; links all 51 states
    │   ├── ContactForm.tsx, CoverageCalculator.tsx
    │   ├── InstantAssessment.tsx, AssociationLeadForm.tsx
    │   ├── QuoteApp.tsx
    │   └── quote/              # schema, session, submission, ui, icons, theme
    ├── components/LegalStrip.astro  # brand→entity line + NAP for the 3 unfootered
    │                                #   templates (/quote, /get-started, /associations)
    ├── data/
    │   ├── states.ts           # 51 state pages — 6 reviewed, 45 noindex
    │   ├── cities.ts           # 22 city pages
    │   ├── landing-pages.ts    # 8 get-started pages
    │   ├── markets.ts          # 12 carrier logos, shared by 2 pages
    │   ├── process.ts          # the 4 placement stages, shared by 2 pages
    │   ├── routes.ts           # THE noindex list; drives the sitemap filter (§3)
    │   └── properties.json     # 64 association pages
    └── styles/                 # global.css, quote.css + per-page CSS
```

---

## 3. Page inventory

**155 HTML pages** from **14 templates**. 35 indexable, 120 deliberately hidden.
Re-measured against a fresh build on 2026-09-07.

| Group | Count | Template | Data source | In sitemap |
| --- | --- | --- | --- | --- |
| Static pages — public | 7 | one `.astro` each | hand-written | Yes |
| Static pages — functional | 3 | `quote.astro`, `documents.astro`, `finance.astro` | hand-written | **No — noindex** |
| State pages — reviewed | 6 | `hoa-insurance-[state].astro` | `states.ts` (`reviewed: true`) | Yes |
| State pages — pending | 45 | same template | `states.ts` (`reviewed: false`) | **No — noindex** |
| City pages | 22 | `hoa-insurance-[city]-[stateAbbr].astro` | `cities.ts` | Yes |
| Get-started landers | 8 | `get-started/[...slug].astro` | `landing-pages.ts` | **No — noindex** |
| Association pages | 64 | `associations/[slug].astro` | `properties.json` | **No — noindex** |
| **Total** | **155** | | | **35 indexed** |

The seven public static pages are `/`, `/about-us/`, `/what-we-do/`, `/why-choose-us/`,
`/contact/`, `/privacy-policy/` and `/terms-of-service/`.

**One built file is not in this table: `/home/`.** `astro.config.mjs` declares
`redirects: { "/home": "/" }`, so `dist/` holds 156 HTML files while Astro reports 155 pages. It
exists because the retired Squarespace origin still serves a sitemap listing
`https://www.protectmyhoa.com/home`, a URL this site has never had, and Google follows it to a
404 on our canonical host. On `output: "static"` Astro emits a meta-refresh page carrying a
canonical to `/` rather than a real 301 — weaker than a redirect rule in the Amplify console,
which is where the durable fix belongs, but it converts a hard 404 into a followed,
self-canonicalising hop. It is not in the sitemap and needs no row above; do not delete it while
that stale sitemap is still being served (§13).

**The previous figures in this section — 153 pages, 12 templates, 44 indexed — are superseded.**
Two templates were added (`documents.astro`, `finance.astro`), and nine URLs that used to be
submitted are now correctly excluded: `/quote/` and the eight `/get-started/*` landers. See
below.

### The single noindex list — `data/routes.ts`

[`web/src/data/routes.ts`](../web/src/data/routes.ts) is now **the** source for which routes stay
out of the index, and `astro.config.mjs` imports `isNoindexRoute()` from it to build the sitemap
filter. Before this, the decision was made in two places that disagreed: the config filtered only
`/associations/` and unreviewed state pages, while `documents.astro` and `finance.astro` set
`noindex` on themselves — so the sitemap submitted two URLs that carry
`<meta name="robots" content="noindex">`. The site was asking Google to crawl the two routes it
goes to the greatest lengths to keep private.

`NOINDEX_ROUTE_PREFIXES` and why each entry is on it:

| Prefix | Why |
| --- | --- |
| `/documents/` | Tokenised document portal — the URL carries a live upload secret |
| `/finance/` | Tokenised premium-finance election — same reason |
| `/associations/` | Private per-association pages, distributed by property managers |
| `/get-started/` | Orphaned paid-traffic landers; six of the eight target the same query as the reviewed state pages, so indexing them runs two competing pages per state |
| `/quote/` | `client:only` — the HTML a crawler receives has an empty body, which earns a Soft 404, not a ranking |

Two things about this list are load-bearing and easy to undo by accident:

1. **The list removes a route from the sitemap. It does not set `noindex` on the page.** The page
   must still do that itself, via `Layout`'s `noindex` prop or its own meta tag. `isNoindexRoute`
   is exported so a page can *ask* rather than restate the prefix.
2. **Most use `noindex, follow`; private association pages use `noindex, nofollow`.** Ads reach
   `/get-started/*` by direct URL and are unaffected, while the association template retains its
   more restrictive link directive.

**`robots.txt` no longer `Disallow`s anything, and that is the correct pairing with this list.**
`/associations/` used to be blocked there, which is counterproductive on its own: a blocked URL is
never fetched, so Googlebot cannot read the very `noindex` that is meant to remove it, and an
already-indexed association page would persist indefinitely. Allowing the crawl lets the noindex
do its job. The tokenised routes are handled the same way — `noindex` plus sitemap exclusion, no
`Disallow` — with the added reason that a `Disallow` line would have to name the paths whose query
strings carry live upload tokens. Keep this rationale in mind before adding a `Disallow` back.

**Sitemap count: 46 → 35.** The nine removed are `/quote/` and the eight `/get-started/*` landers;
`/documents/` and `/finance/` were in the old 46 as well, so the arithmetic is 46 − 9 − 2 = 35,
against 35 measured in `dist/sitemap-0.xml`. If you change this list, re-count (§14).

### The 45 pending state pages are hidden on purpose

`states.ts` covers all 50 states plus DC, but only six carry checked, state-specific
substance — chiefly the statutory citations in `regulations`, which differ in every state
and must not be guessed on an insurance site. The other 45 are built from one `pending()`
helper whose copy is deliberately generic, and they are **`noindex, follow` and excluded
from the sitemap**. Publishing 45 pages built from one template with no state-specific
substance is the textbook definition of doorway content and would put the six pages that
currently rank at risk.

Two guards, and both are driven off the same flag so they cannot disagree:

1. `noindex={!state.reviewed}` → the `noindex` prop on `Layout.astro` —
   [`hoa-insurance-[state].astro:36`](../web/src/pages/hoa-insurance-%5Bstate%5D.astro#L36)
2. Sitemap exclusion via `reviewedStateSlugs` — the `isUnreviewedStatePage` predicate in
   [`astro.config.mjs`](../web/astro.config.mjs) (line numbers omitted deliberately; that file
   moved in the 2026-09-07 pass and a stale line anchor is worse than none)

**Flipping a state to `reviewed: true` indexes it and adds it to the sitemap in one edit.**
Only do that once its own statute, market and exposure detail has been written and reviewed.

### The 64 association pages are hidden on purpose

Private, property-manager-distributed HO-6 links generated by the Buildium sync. **Two
independent guards — both must stay:**

1. `<meta name="robots" content="noindex, nofollow">` + `<meta name="googlebot" ...>` —
   [`associations/[slug].astro`](../web/src/pages/associations/%5Bslug%5D.astro)
2. Sitemap exclusion — now via `NOINDEX_ROUTE_PREFIXES` in
   [`web/src/data/routes.ts`](../web/src/data/routes.ts), read by `astro.config.mjs`'s filter.
   It used to be a hardcoded `/associations/` check in the config; see the subsection above.

**There used to be a third: `Disallow: /associations/` in `robots.txt`. It was removed on
purpose — do not restore it.** A blocked URL is never fetched, so Googlebot could not read the
`noindex` that is supposed to remove the page, and any association page already in the index would
have stayed there indefinitely. The `Disallow` was working against the guard it looked like it was
reinforcing. Nothing is exposed by allowing the crawl that the distributed link did not already
expose, and these URLs carry no secret.

### robots.txt

```
User-agent: *
Allow: /

Sitemap: https://www.protectmyhoa.com/sitemap-index.xml
```

Plus roughly twenty lines of comment explaining why there is no `Disallow` and pointing at
`web/src/data/routes.ts` as the single source for the noindex decision. Read those before editing
the file.

---

## 4. Complete title list

### Static pages (8 of the 10)

Lengths are decoded character counts (`&amp;` counted as one character).
`/documents/` and `/finance/` are omitted: they are tokenised private routes with no organic
role, and both are `noindex` + `private` (no analytics, no referrer). See §3.
`/quote` is listed for completeness but is **no longer indexed** — see §3.
Two of these were rewritten in the 2026-09-07 pass and re-extracted from `dist/` on that date:
`/about-us` (was *"About HOA Insurance Agency — Independent HOA & Condo Insurance Brokerage"*)
and `/contact` (was *"Contact HOA Insurance Agency — HOA & Condo Insurance Specialists"*). Both
now name the brand rather than describing the practice, which is the change §9 is about; the old
strings are recorded here so the next pass does not "restore" them from this table.

| URL | `<title>` | Len |
| --- | --- | --- |
| `/` | HOA Insurance for Condominium Associations & Unit Owners — ProtectMyHOA | 71 |
| `/about-us` | About HOA Insurance Agency — the Agency Behind ProtectMyHOA | 59 |
| `/what-we-do` | HOA Insurance & HO-6 Coverage — ProtectMyHOA | 44 |
| `/why-choose-us` | Why Choose HOA Insurance Agency — Specialists in HOA & Condo Insurance | 70 |
| `/contact` | Contact HOA Insurance Agency — ProtectMyHOA | 43 |
| `/quote` | HOA Insurance Quote · ProtectMyHOA | 34 |
| `/privacy-policy` | Privacy Policy — HOA Insurance Agency | 37 |
| `/terms-of-service` | Terms of Service — HOA Insurance Agency | 39 |

### State pages — indexed (6) — `states.ts` → `title`

| URL | `<title>` |
| --- | --- |
| `/hoa-insurance-massachusetts` | HOA Insurance in Massachusetts — ProtectMyHOA |
| `/hoa-insurance-rhode-island` | HOA Insurance in Rhode Island — ProtectMyHOA |
| `/hoa-insurance-new-hampshire` | HOA Insurance in New Hampshire — ProtectMyHOA |
| `/hoa-insurance-connecticut` | HOA Insurance in Connecticut — ProtectMyHOA |
| `/hoa-insurance-new-york` | HOA Insurance in New York — ProtectMyHOA |
| `/hoa-insurance-oklahoma` | HOA Insurance in Oklahoma — ProtectMyHOA |

### State pages — pending (45, noindex) — `states.ts` → `pending()`

Built, reachable from the coverage map, kept out of the index and the sitemap. All 45 take
one generated title:

```
HOA Insurance in {State} — ProtectMyHOA
```

The 45: Alabama · Alaska · Arizona · Arkansas · California · Colorado · Delaware ·
District of Columbia · Florida · Georgia · Hawaii · Idaho · Illinois · Indiana · Iowa ·
Kansas · Kentucky · Louisiana · Maine · Maryland · Michigan · Minnesota · Mississippi ·
Missouri · Montana · Nebraska · Nevada · New Jersey · New Mexico · North Carolina ·
North Dakota · Ohio · Oregon · Pennsylvania · South Carolina · South Dakota · Tennessee ·
Texas · Utah · Vermont · Virginia · Washington · West Virginia · Wisconsin · Wyoming

### City pages (22) — `cities.ts` → `title`

| URL | `<title>` |
| --- | --- |
| `/hoa-insurance-boston-ma` | HOA Insurance in Boston, MA — ProtectMyHOA |
| `/hoa-insurance-worcester-ma` | HOA Insurance in Worcester, MA — ProtectMyHOA |
| `/hoa-insurance-springfield-ma` | HOA Insurance in Springfield, MA — ProtectMyHOA |
| `/hoa-insurance-cambridge-ma` | HOA Insurance in Cambridge, MA — ProtectMyHOA |
| `/hoa-insurance-marlborough-ma` | HOA Insurance in Marlborough, MA — ProtectMyHOA |
| `/hoa-insurance-providence-ri` | HOA Insurance in Providence, RI — ProtectMyHOA |
| `/hoa-insurance-warwick-ri` | HOA Insurance in Warwick, RI — ProtectMyHOA |
| `/hoa-insurance-cranston-ri` | HOA Insurance in Cranston, RI — ProtectMyHOA |
| `/hoa-insurance-manchester-nh` | HOA Insurance in Manchester, NH — ProtectMyHOA |
| `/hoa-insurance-nashua-nh` | HOA Insurance in Nashua, NH — ProtectMyHOA |
| `/hoa-insurance-concord-nh` | HOA Insurance in Concord, NH — ProtectMyHOA |
| `/hoa-insurance-hartford-ct` | HOA Insurance in Hartford, CT — ProtectMyHOA |
| `/hoa-insurance-stamford-ct` | HOA Insurance in Stamford, CT — ProtectMyHOA |
| `/hoa-insurance-new-haven-ct` | HOA Insurance in New Haven, CT — ProtectMyHOA |
| `/hoa-insurance-bridgeport-ct` | HOA Insurance in Bridgeport, CT — ProtectMyHOA |
| `/hoa-insurance-new-york-city-ny` | HOA Insurance in New York City — ProtectMyHOA |
| `/hoa-insurance-buffalo-ny` | HOA Insurance in Buffalo, NY — ProtectMyHOA |
| `/hoa-insurance-rochester-ny` | HOA Insurance in Rochester, NY — ProtectMyHOA |
| `/hoa-insurance-albany-ny` | HOA Insurance in Albany, NY — ProtectMyHOA |
| `/hoa-insurance-oklahoma-city-ok` | HOA Insurance in Oklahoma City — ProtectMyHOA |
| `/hoa-insurance-tulsa-ok` | HOA Insurance in Tulsa, OK — ProtectMyHOA |
| `/hoa-insurance-norman-ok` | HOA Insurance in Norman, OK — ProtectMyHOA |

### Get-started landing pages (8, now noindex) — `landing-pages.ts` → `metaTitle`

These eight are still built and still work as ad destinations; they are simply no longer
submitted for indexing. See §3.

| URL | `<title>` |
| --- | --- |
| `/get-started` | Free HOA Insurance Assessment — ProtectMyHOA |
| `/get-started/massachusetts` | Free Massachusetts HOA Insurance Assessment — ProtectMyHOA |
| `/get-started/rhode-island` | Free Rhode Island HOA Insurance Assessment — ProtectMyHOA |
| `/get-started/new-hampshire` | Free New Hampshire HOA Insurance Assessment — ProtectMyHOA |
| `/get-started/connecticut` | Free Connecticut HOA Insurance Assessment — ProtectMyHOA |
| `/get-started/new-york` | Free New York HOA Insurance Assessment — ProtectMyHOA |
| `/get-started/oklahoma` | Free Oklahoma HOA Insurance Assessment — ProtectMyHOA |
| `/get-started/new-england` | Free New England HOA Insurance Assessment — ProtectMyHOA |

### Association pages (64, noindex) — one template

```
HO-6 Condo Insurance for {property.name} — ProtectMyHOA
```

[`associations/[slug].astro:49`](../web/src/pages/associations/%5Bslug%5D.astro#L49). The 64 `{property.name}` values from `properties.json`:

114 Elm Street Condominium · 26 Moseley St Condominiums · 420 Lakeside Office Condominium Trust · 43 Withington St Condominiums · 52 Withington St Condominium · 65-69 Nightingale Condominium · 66 Hamilton Street Condominium · 680 South Ave Condominium Trust · 7 Oakcrest Condominium · 73 Dix Street Condominium · 755 Lofts Condominiums · 81 Summer St Condominium · Adams House Condominium · Admiral Dewey House Condominium · Alpine Village Condominium · Applewood Three Condominium Association · Applewood Two Condominium Association · Baiting Brook Farm Condominium · Baseball Factory · Chestnut Grove Condominium Trust · Chestnut Hill Woods · Craftsman Village Condominium · Custer Estate Condominium Trust · Cypress Gardens Condominiums · Eagles View Condominiums · Explorers @ VOAT · Fairland Gardens Condominiums · Fallbrook Condominium · Forge Hill Condominium · Freedom Village @ VOAT · Furnace Brook Estates · Geneva Mills Condominium · Hadwen Park Place II Condominiums · High Rock Condominiums · Independence Village @ VOAT · Ledgewood Estates Condominium Trust · Longley Trace Condominium Trust · Louisiana Purchase @ VOAT · Maple Ridge Town Home Condominium · Mayflower Landing @ VOAT · Medfield Crossing Condominium Trust · Mosley Park Condominium Trust · Northside Meadow Condominium Trust · Oak Knoll Condominium · Old Stone Bridge Acres Condominiums · One Hundred Captains Row Condominium Trust · Partridge Berry Hills Condominium Association · Pheasant Hill Condominium Trust · Pizzi Farm · Reservoir Place Condominium · Residences at Stedman · River Village Condominium · Rose Stone Village Condominium · Sargent Estates Condominiums · Sixteen Everett Ave Condominiums · Spruce Hill Condominium Association · The Villages At Dale Woods Condominiums · Trail View Condominium · Trailside Terrace Condominiums · Uncommon Place Condominium · Vecchia Gardens Condominium · VOAT Infrastructure Trust · Weatherstone at Blithewood Condominium · Webber Village Condominium

---

## 5. Where the SEO lives

### One shared head for most of the site

[`web/src/layouts/Layout.astro`](../web/src/layouts/Layout.astro) is the single `<head>` for
**every indexable page** (82 of the 155 built — the eleven templates that are not `/quote`,
`/get-started/*` or `/associations/*`). It owns:

- `<title>`, `<meta name="description">`
- `<link rel="canonical">` — from `canonicalUrl()` in `lib/seo.ts`, **not** string concatenation
- Open Graph: `og:type`, `og:title`, `og:description`, `og:image`, `og:url`, `og:site_name`
  (`og:site_name` is `AGENCY.brandName`, i.e. ProtectMyHOA)
- Twitter: `summary_large_image` card + title/description/image
- The **single** structured-data `@graph` — see §7
- Both analytics tags, and the switch that suppresses them

Pages feed it eight props: `title`, `description`, `ogImage`, `canonicalPath`, `jsonLd`,
`noindex`, `private`, `solidNav`. (`ogImage` was missing from the earlier five-prop and
seven-prop versions of this list; it defaults to `/logo.png` and no page currently overrides it,
which is why it kept getting overlooked.)

`noindex` is opt-in and defaults to false, so the pages that already used this layout were
unaffected when it was added. Callers are the state template (`!state.reviewed`, §3) and the two
tokenised routes.

`private` is the newer one and is **not optional on a tokenised route**. It suppresses
`<Analytics />` and emits `<meta name="referrer" content="no-referrer">`. GA4's `config` call
reports `page_location`, which is the *full* URL including the query string — so without it a
page reached as `?t=<token>` hands a live upload token to GA4, Google Ads and Clarity, where
anyone with report access can read one off. `/documents/` and `/finance/` both set it.

### The canonical / URL contract

Four facts, and they have to agree. Three of them are in this repository; **the fourth is not.**

| Fact | Where it is declared |
| --- | --- |
| The canonical host is `https://www.protectmyhoa.com` — `www`, never the apex | `AGENCY.site` in [`shared/agency.ts`](../shared/agency.ts), re-exported as `SITE_ORIGIN` by [`web/src/lib/seo.ts`](../web/src/lib/seo.ts) |
| URLs carry a **trailing slash**: `/about-us/`, not `/about-us` | `trailingSlash: "always"` in [`astro.config.mjs`](../web/astro.config.mjs) |
| Every canonical, `og:url` and `@id` is built from those two | `canonicalUrl()` / `absoluteUrl()` in `lib/seo.ts`; `Layout.astro` calls them |
| **The redirects that make the above true** — apex 302 → `www`, `/about-us` 301 → `/about-us/` | **The AWS Amplify console only. NOT in version control.** |

**Pages may pass `canonicalPath` in any shape.** `canonicalUrl()` normalises `""`, `"/about-us"`,
`"/about-us/"` and `"about-us"` to the same trailing-slash answer, so a new page cannot
reintroduce the defect by passing the wrong one. That is the whole reason the normalisation lives
in the function rather than at the call sites.

**What the defect was.** Every canonical on the site used to omit the trailing slash while
`@astrojs/sitemap` emitted it *with* one, and Astro sat at its `trailingSlash: "ignore"` default
because nothing in the repo declared otherwise. So each page's self-referential canonical named a
URL that 301-redirected, and the sitemap disagreed with the canonicals on all 46 submitted URLs —
a self-contradicting signal on every ranking page.

> ⚠ **The redirect rules are not in this repository, and nothing here can detect a change to
> them.** The apex 302 and the trailing-slash 301 live in the AWS Amplify console's rewrite/
> redirect table for the `web` app. If someone edits or removes them there, every canonical this
> site emits silently becomes a claim about a URL that no longer behaves that way — no build
> fails, no test catches it, and the first symptom is a slow ranking loss. **Before changing
> anything in that table, read this section.** If the contract has to change, the change is:
> Amplify console → `AGENCY.site` and/or `trailingSlash` → rebuild → re-save the SEO baseline
> (§14). `crm/src/test/webSeo.test.ts` asserts that `astro.config.mjs`'s `site` still equals
> `AGENCY.site`, which is the one half of this that *is* enforced.

### Three templates bypass the layout

`/quote`, `/get-started/*`, and `/associations/*` each hand-roll their own `<html>`/`<head>`.

**The analytics block is no longer duplicated.** All four heads now import the same
[`components/Analytics.astro`](../web/src/components/Analytics.astro), which reads its
measurement IDs from `constants.ts`. A tag change is one edit in one file.

| File | Analytics |
| --- | --- |
| [`layouts/Layout.astro`](../web/src/layouts/Layout.astro) | `{!isPrivate && <Analytics />}` — the one conditional one; see `private` above |
| [`pages/quote.astro`](../web/src/pages/quote.astro) | `<Analytics />` |
| [`pages/get-started/[...slug].astro`](../web/src/pages/get-started/%5B...slug%5D.astro) | `<Analytics />` |
| [`pages/associations/[slug].astro`](../web/src/pages/associations/%5Bslug%5D.astro) | `<Analytics />` |

(Line anchors dropped from this table for the same reason as in §3: all four moved in the
2026-09-07 pass, and a stale line anchor is worse than none.)

What the bypass still costs, re-verified in the built HTML on 2026-09-07:
- `/quote` and `/get-started/*` have **no Twitter card**. They *do* now carry a canonical, an
  `og:image` and the full `@graph`, because both templates import `canonicalUrl()`,
  `absoluteUrl()` and `siteGraph()` from `lib/seo.ts` rather than hand-rolling them. The earlier
  version of this bullet said they had no `og:image` either; that was true before `lib/seo.ts`
  existed and is not true now.
- `/associations/*` still has **no canonical and no JSON-LD** — the only one of the three that
  remains fully bare.

All three are `noindex` (§3), so the missing head furniture costs nothing organically. What
it *did* cost was legal and identity surface: these three templates get no `Footer.astro`, and
between them they are the quote wizard, every paid-traffic lander and all 64
property-manager-distributed pages — the three surfaces that collect the most PII on the site,
and the only ones that named no legal entity, showed no postal address and linked to no privacy
policy. On `/get-started` the address existed only inside the JSON-LD, which is to say only for
machines.

[`components/LegalStrip.astro`](../web/src/components/LegalStrip.astro) now closes that. All
three import it. It renders `AGENCY_FMT.brandLine` — *"ProtectMyHOA is the consumer-facing brand
of HOA Insurance Agency LLC."* — plus the NAP, the two legal links, and the licensure/no-bind
qualifier. These are the most ProtectMyHOA-branded pages on the site, which is exactly where the
brand has to resolve to the licensed agency.

`/get-started/*` also **no longer emits its own trimmed `InsuranceAgency` node.** It uses
`siteGraph()` from `lib/seo.ts` like everything else — see §7.

### Heading structure (verified in built HTML)

> **The "JSON-LD blocks" column below is stale as a count and is kept only for the heading
> figures.** It was measured when pages emitted a stack of separate `<script type="application/
> ld+json">` blocks — two on `/` and `/what-we-do` (the agency plus the FAQ), one elsewhere.
> Every page that uses `Layout.astro` now emits **exactly one** block containing one `@graph`,
> and the FAQ is a node inside it rather than a block of its own. Re-measure before quoting it.
> See §7.

| Page | H1 | H2 | H3 | JSON-LD blocks |
| --- | --- | --- | --- | --- |
| `/` | 1 | 11 | 19 | 2 |
| `/about-us` | 1 | 4 | 1 | 1 |
| `/what-we-do` | 1 | 7 | 22 | 2 |
| `/why-choose-us` | 1 | 4 | 9 | 1 |
| `/contact` | 1 | 1 | 2 | 1 |
| `/hoa-insurance-massachusetts` | 1 | 6 | 8 | 1 |
| `/hoa-insurance-texas` (pending) | 1 | 5 | 8 | 1 |
| `/hoa-insurance-boston-ma` | 1 | 4 | 1 | 1 |
| `/privacy-policy` | 1 | 13 | 6 | 1 |
| `/terms-of-service` | 1 | 15 | 0 | 1 |
| `/get-started` | 1 | 0 | 1 | 1 |
| `/quote` | **0** | 0 | 0 | **0** |

A pending state page carries one H2 fewer than a reviewed one: the "Cities We Serve"
section is gated on `stateCities.length > 0` and `cities` is empty for all 45.

Every page has exactly one H1 except `/quote` (see [Known issues](#13-known-issues)). H1 text comes from:

- Static pages → the `<Hero title="...">` prop
- State pages → `states.ts` → `heroTitle`
- City pages → `cities.ts` → `heroTitle`
- Get-started → `landing-pages.ts` → `headline`

---

## 6. Edit safety classification

> **Re-read this section before relying on the previous pass's classification.** Several strings
> that were marked 🔴 DO NOT CHANGE were marked that way to protect *the wording that was
> shipping at the time* — including the homepage meta description, which named six states. Those
> strings have since been corrected. **"Do not change" now means "do not change back."** A
> classification that still guarded the old text would get the correction reverted by the next
> content pass, which is exactly the failure mode this table exists to prevent.

### 🔴 DO NOT CHANGE — URLs and ranking signals

| What | Where |
| --- | --- |
| `slug` fields | `states.ts`, `cities.ts`, `landing-pages.ts` — **these ARE the URLs** |
| Filenames in `src/pages/` | renaming = new URL = lost ranking |
| `title` / `description` | `states.ts`, `cities.ts` |
| `metaTitle` / `metaDescription` | `landing-pages.ts` |
| `title=` / `description=` / `canonicalPath=` props | the static pages |
| Published `@id` values | `ORG_ID`, `BRAND_ID`, `WEBSITE_ID`, `FOUNDER_ID`, `SPECIALIST_ID` in `lib/seo.ts` — an `@id` **is** the entity; changing one creates a second company. See §7 |
| `canonicalUrl()` / `SITE_ORIGIN` | [`lib/seo.ts`](../web/src/lib/seo.ts) — the URL contract, §5 |
| `trailingSlash` / `site` | [`astro.config.mjs`](../web/astro.config.mjs) — paired with the Amplify redirect rules, §5 |
| The `<head>` of `Layout.astro` | canonical / OG / Twitter / `@graph` machinery |
| `robots.txt` | crawl directives |
| `NOINDEX_ROUTE_PREFIXES` | [`data/routes.ts`](../web/src/data/routes.ts) — drives both the page's `noindex` and the sitemap filter, §3 |
| The association noindex guards | see §3 |
| `reviewed: true/false` in `states.ts` | flips both indexing and sitemap inclusion — see §3 |

### 🔴 CORRECTED — do not restore the previous wording

These were on the DO-NOT-CHANGE list under their **old** text. They have been rewritten in this
pass and the protection now attaches to the new wording. Each is here because the old version
asserted something that could not be supported.

| What | What it used to say | Why it changed |
| --- | --- | --- |
| Homepage `description=` prop, [`index.astro`](../web/src/pages/index.astro) | "…for associations in MA, RI, NH, CT, NY, OK." | The agency is licensed in all 50 states and DC. The six-state list was three jurisdictions short of the truth and contradicted the site's own coverage map. See §7 |
| `/get-started` lander copy + `metaDescription`, [`get-started/[...slug].astro`](../web/src/pages/get-started/%5B...slug%5D.astro) | "Serving MA, RI, NH, CT, NY, and OK" | Same. Now interpolates `AGENCY.areaServed` rather than typing a footprint by hand |
| `areaServed` in the JSON-LD | six `@type: State` nodes, on **every** page | A Texas page shipped schema saying the agency does not serve Texas. Now one `Country` node — §7 |
| The `CoverageCalculator` state gate, [`CoverageCalculator.tsx`](../web/src/components/CoverageCalculator.tsx) | rejected any state outside the six | A visitor arriving from `/hoa-insurance-texas` was told the agency does not serve their state |
| `faqJsonLd` / `FAQS` on `/` and `/what-we-do` | described in this document as a 6-question / 3-question set and as "rich-result eligible" | Both wrong now — the question sets were replaced, and FAQ rich results are not available to a commercial insurance site. See §7 |
| Anything naming ProtectMyHOA as an agency | — | It is a **brand** of HOA Insurance Agency LLC, and its trade-name registration is unverified. See §9 |

### 🟡 CAREFUL — H1s, link graph, NAP

- **`heroTitle`** (states/cities) and **`headline`** (landing-pages) render as the **H1**. Editable, but keep the primary keyword — H1 is a genuine ranking signal.
- **`cities: [...]`** array in `states.ts` drives state→city internal links. Removing a name orphans that city page from its hub.
- **Phone / email / address / brand / footprint / founding date** all live in
  [`shared/agency.ts`](../shared/agency.ts) and feed the JSON-LD. This is your NAP consistency for
  local SEO — it must keep matching your Google Business Profile and your licensing records.
  **Edit `AGENCY` only; never hand-edit `AGENCY_FMT`.** See §9.
- **FAQ answer text** on `/` and `/what-we-do` is *both* visible copy and `FAQPage` schema — the
  same array feeds both. Rewording changes the schema payload, so keep the two in step; it does
  **not** change a rich result, because there isn't one to change (§7). Treat as 🟡, not 🔴 —
  the previous 🔴 was justified by a rich-result eligibility the site does not have.

### 🟢 SAFE — pure content

- All body copy in the 8 static pages (everything below the `<Layout ...>` props)
- `intro`, `regulations`, `hoaTypes` in `states.ts`
- `subheadline`, `trustSignals`, `urgencyText` in `landing-pages.ts`
- `Hero` `subtitle` and `eyebrow` props
- The content arrays: `COVERAGES`, `STEPS`, `CLIENT_TYPES` (index), `MASTER_COVERAGES`, `COMMON_ISSUES`, `HO6_COVERAGES` (what-we-do)
- All CSS files, all images

---

## 7. Structured data

**All of it is owned by one module:** [`web/src/lib/seo.ts`](../web/src/lib/seo.ts). Nothing else
declares an entity, and nothing restates a fact — every value derives from
[`shared/agency.ts`](../shared/agency.ts). The module is deliberately framework-free (plain values
and pure functions, no Astro imports) so `crm/src/test/webSeo.test.ts` can import and assert on
the real graph rather than on a copy of it.

### Connected structured-data graph

The current implementation has `Layout.astro` emit one `<script type="application/ld+json">`,
built by `siteGraph()`. That is an implementation choice, not an SEO requirement: separate
JSON-LD blocks can participate in the same graph when they use the same stable `@id` values.
The emitted graph contains these connected nodes:

| Node | `@id` | What it is |
| --- | --- | --- |
| `InsuranceAgency` | `…/#organization` | **The** company. `name` = HOA Insurance Agency, `legalName` = HOA Insurance Agency LLC, `alternateName` = ProtectMyHOA |
| `Brand` | `…/#brand` | ProtectMyHOA. `parentOrganization` → `#organization`. Deliberately carries no address, no phone, no licence — everything regulated belongs to the org |
| `WebSite` | `…/#website` | `publisher` → `#organization` |
| `WebPage` | `<this page's canonical>#webpage` | `isPartOf` → `#website`, `about`/`publisher` → `#organization` |
| `Person` (founder) | `…/about-us/#jake-greasley` | `worksFor` → `#organization` |
| *page-specific nodes* | varies | Passed in through `Layout`'s `jsonLd` prop; they join the same graph |

The 64 private association pages do not emit this graph, a canonical link, or an Open Graph
URL; their minimal noindex/nofollow template deliberately stays outside the public entity graph.

Page-specific nodes currently in use: the two `FAQPage` blocks (below) and the `/contact`
specialist `Person` (`…/contact/#brian-cole`). `breadcrumbSchema()` exists in `lib/seo.ts` and is
not yet called by any page.

**Why the implementation uses one graph.** A single builder keeps identifiers and facts from
drifting across templates. The earlier problem was not the number of script blocks; it was two
independently authored `InsuranceAgency` nodes without a shared stable identity.

### The rules

These are not stylistic. Each one exists because breaking it splits the entity or invents a claim.

1. **Never add a second `Organization`, `InsuranceAgency`, `LocalBusiness` or `FinancialService`
   node.** There is exactly one per graph-bearing page, built by `organizationSchema()`.
   If a page needs to say something about the agency, it references `{ "@id": ORG_ID }`.
   `Layout.astro`'s `jsonLd` prop documents this in its own comment.
2. **Never change a published `@id`.** An `@id` *is* the entity to a consumer. Editing one does
   not rename the company; it creates a second one and orphans the first.
3. **No `aggregateRating` and no `review`.** The Google Business Profile reportedly carries eight
   five-star reviews, but self-serving review markup on an organization is against Google's
   structured-data policy, and there is no eligible visible review content on the site to support
   it anyway.
4. **ProtectMyHOA is modelled as an `alternateName` plus a `Brand`, never as an agency.** See §9
   for why — the trade-name registration is unverified.
5. **Use confirmed roles only.** Jake Greasley's confirmed title is **Founder and President**;
   do not substitute Producer, CEO, Principal or CFA. Brian Cole's user-confirmed title is
   **Licensed Insurance Producer**, used in both `/contact` copy and the specialist `Person`'s
   `jobTitle`.

`sameAs` is an identity assertion, not a general link list. The organization node holds its three
agency profiles. The founder node derives six approved profiles from `FOUNDER_PROFILES` in
`shared/agency.ts`; those same six links are visible on `/about-us/`. `jakegreasley.com` remains
absent until it resolves — see §13.

### Service area — the six-state footprint is obsolete

**MA / RI / NH / CT / NY / OK is dead. Do not restore it anywhere.**

The agency is licensed in **all 50 states and the District of Columbia**. That sentence is stored
once, as prose, in `AGENCY.areaServed`, and every rendered surface interpolates it. It is stored
as a sentence rather than a state array precisely because the array is what drifted: `states.ts`
grew to 51 entries while five other surfaces went on describing six.

Where the six-state list was removed in this pass:

| Surface | Was | Now |
| --- | --- | --- |
| JSON-LD `areaServed` (on **every** page) | 6 × `@type: State` | one `{ "@type": "Country", name: "United States" }` |
| Homepage meta description | "…associations in MA, RI, NH, CT, NY, OK" | no state list |
| `/get-started` lander copy + meta | "Serving MA, RI, NH, CT, NY, and OK" | interpolates `AGENCY.areaServed` |
| `CoverageCalculator.tsx` state gate | rejected any state outside the six | no six-state gate |

A `Country` node is both accurate and impossible to leave half-updated, which is the point: the
old version shipped on all 51 state pages, so a Texas page carried schema saying the agency does
not serve Texas.

> **Licensure is not product availability.** `areaServed` says the agency may transact in all 51
> jurisdictions. It does **not** say every carrier, program or coverage form is obtainable in each
> of them, and copy must not imply that. The site already has the right qualifier sentences for
> this — *"Carrier availability varies by state, association type and risk profile"* and
> *"Coverage is subject to underwriting, policy terms, and eligibility"* — reuse them rather than
> inventing new ones. `landing-pages.ts` still names a region on
> `/get-started/new-england`, and that is fine — it is a statement about which market a *lander
> targets*, not a footprint claim. It is kept honest by pairing: the meta description now reads
> *"Serving MA, RI, NH, and CT — licensed in all 50 states and the District of Columbia"*, and the
> lander's trust signals interpolate `AGENCY.areaServed` directly underneath the regional line.
> A regional lander may name its region; it may not leave the region looking like the footprint.

### `FAQPage` — what is actually there, and why it is not a rich result

**This section previously described a different FAQ configuration and called it "rich-result
eligible". Both were wrong. Corrected below.**

Two pages carry an `FAQPage` node, each passed into `Layout`'s `jsonLd` prop and merged into that
page's `@graph`. On both, one `FAQS` array is the source for **both** the visible accordion and
the schema, so the two cannot disagree.

| Page | Questions | Source |
| --- | --- | --- |
| `/` | **4** | `FAQS` + `faqJsonLd` in [`index.astro`](../web/src/pages/index.astro) |
| `/what-we-do` | **3** | `FAQS` + `faqJsonLd` in [`what-we-do.astro`](../web/src/pages/what-we-do.astro) |

The four homepage questions, as they now stand: what an HOA master policy covers · which of the
three master-policy types an association has · who pays when a pipe leaks into a unit · whether an
owner still needs an HO-6. The previous six — which included *"What states does HOA Insurance
Agency serve?"*, answered with the six-state list — were replaced on 2026-08-11. The three
`/what-we-do` questions: master policy vs HO-6 · who pays for the master policy · what a board
should review at renewal.

**These blocks will not produce a rich result, and they were never going to.** In August 2023
Google restricted FAQ rich results to well-known government and health websites. A commercial
insurance site is not eligible, so the markup earns no SERP real estate regardless of how it is
written. The earlier framing here — "your highest-value and most fragile SEO asset" — was
therefore an overstatement of both the value and the fragility, and it is the reason the FAQ text
was classified 🔴 in §6.

**They are kept for entity clarity, not for a rich result.** The questions and answers restate the
site's core subject matter in a form that is unambiguous to a consumer parsing the page, and they
sit inside the same `@graph` as the organization, so they are attributable to it. That is worth
having. It is not worth freezing the copy over: reword freely, keep the array as the single source
for both surfaces, and re-run the fingerprint check (§14) afterwards.

---

## 8. Internal link graph

Hub-and-spoke, correctly built:

```
/  ──────────────► all 51 state pages   (via CoverageMap)
/contact ────────► all 51 state pages   (same component)
                   │
state page ────────┼──► its own city pages (from the `cities` array)
                   └──► /about-us /what-we-do /why-choose-us /quote
city page ─────────────► its parent state page
Navbar   (every page) ─► / /what-we-do /why-choose-us / /contact
Footer   (every page) ─► /privacy-policy /terms-of-service
```

[`CoverageMap.astro`](../web/src/components/CoverageMap.astro) is the **only** crawl path
from the homepage to the state pages. Every state is a real `<a href>` around its SVG
outline, including the 45 that are `noindex` — they are crawlable but not indexable, which
is the intent (`noindex, follow` passes link equity onward). It renders on `/` and
`/contact`.

The 45 pending state pages have an empty `cities` array, so they link to no city page.

Nav links are defined once in [`constants.ts:95-114`](../web/src/constants.ts#L95-L114).
Two things there are deliberate and easy to misread:

- **"About Us" points at `/`, not `/about-us`.** `/about-us` still exists and is still
  indexed, but its only internal link is now the "About our insurance agency" link in the
  homepage practice section. Do not remove that link without restoring the nav path.
- **"Contact" is a real route** (`/contact`), no longer the `/#contact` anchor.

`NAV_LINKS` intentionally omits `/quote` and `/get-started`; the quote CTA is rendered
separately.

**Note:** no page links to `/get-started/*` — those 8 pages are reachable only from ads. That is by design for paid traffic. They are **no longer in the sitemap** either (§3), which is the point: an orphaned page that duplicates the query its state page already ranks for is a competitor, not a spoke. Ads reach them by direct URL and `noindex, follow` does not affect that.

---

## 9. Agency identity (NAP)

Single source of truth: [`shared/agency.ts`](../shared/agency.ts). Deliberately dependency-free so Astro pages, React islands, the Vite SPA, and Vitest can all import it.

The user-supplied canonical fact sheet is an authorized factual source, even when those facts
were not previously documented in the repository. This module is the implementation source,
not the only permissible source of evidence.

| Field | Value | Field in `shared/agency.ts` |
| --- | --- | --- |
| Legal name | HOA Insurance Agency LLC | `AGENCY.name` |
| Public organization name | HOA Insurance Agency | `AGENCY_FMT.displayName` (derived — the legal name minus the `LLC` suffix) |
| Consumer brand | ProtectMyHOA | `AGENCY.brandName` |
| **Trade name / DBA** | **NOT VERIFIED — see below** | *no field exists* |
| Formation date | 2025-12-30 | `AGENCY.foundingDate` |
| Licensed footprint | all 50 states and the District of Columbia | `AGENCY.areaServed` |
| Founder | Jake Greasley — legally Jacob Charles Greasley; Founder and President | `AGENCY.founderDisplayName` / `AGENCY.founderLegalName` / `AGENCY.founderJobTitle` |
| ACORD operational contact | HOA Insurance Agency LLC — company only, no person's name | `AGENCY.contactName` |
| Address | 420 Lakeside Ave, Suite 202, Marlborough, MA 01752 | `AGENCY.addressLine1` + `city`/`state`/`zip` |
| Phone | 508-233-2261 | `AGENCY.phone` |
| Email (general) | insurance@ProtectMyHOA.com (canonical mixed case) | `AGENCY.email` |
| Email (sales / lead delivery) | sales@ProtectMyHOA.com | `AGENCY.leadEmail` |
| Site | https://www.protectmyhoa.com | `AGENCY.site` |

`AGENCY_FMT` derives every reformatted variant — `tel:` href, E.164, schema.org `telephone`, footer address line, FormSubmit endpoint, the unmarked brand/entity line, and the visible `ProtectMyHOA™` label. **Edit `AGENCY` only; never hand-edit `AGENCY_FMT`.** Founder identity fields are deliberately separate from the operational `contactName` used by ACORD generation.

### Trade name / DBA — NOT VERIFIED

**Nothing in this repository establishes that ProtectMyHOA is a registered trade name, DBA or
fictitious name in any insurance jurisdiction.** There is no filing, no licence record naming it,
and the CRM's own `License` model has no trade-name field that could hold one. Domain ownership,
logo files and branded mailboxes are **not** trade-name registration. Trademark notation is a
separate question: the visible brand may use the unregistered `™` symbol, while `®` must not be
used without a federal registration. Trademark symbols stay out of schema identifiers and other
machine-readable identity fields.

The consequence for copy is narrow and firm: **published copy must present ProtectMyHOA as a
brand OF the licensed agency, and must never present it as an agency in its own right.** The site
does this in three places — `AGENCY_FMT.brandLine` in the footer and in `LegalStrip.astro`, the
visible statement on `/about-us`, and the `alternateName` + `Brand` modelling in the JSON-LD
(§7).

**What would change this row.** A trade-name / DBA / assumed-name registration on file with an
insurance regulator, evidenced by the state(s) and the filing or licence number. Record those in
`shared/agency.ts` beside `brandName` first — that is where the next person will look — and only
then revisit the wording. Anything short of a filing number leaves this row as it is.

### Two facts that constrain copy more than they look

- **Formation date 2025-12-30** constrains claims about the agency's age, not independently
  verified customer counts, testimonials, outcomes or an individual's prior experience.
  Preserve confirmed metrics and distinguish the agency's history from its team's experience.
- **Founder and President.** "Jake Greasley" is the public display name; "Jacob Charles
  Greasley" is the full legal name. Jake and the agency are individually licensed in all 50
  states and the District of Columbia. The ACORD operational contact stays in its own field so
  form-generation changes cannot silently rewrite the founder entity; it names the company,
  HOA Insurance Agency LLC, not Jake or another individual.

### Business confirmations — 2026-09-07

The user has confirmed the following facts and commitments:

- **Brian Cole is a Licensed Insurance Producer.** His visible title and `Person.jobTitle`
  use that exact role; it does not imply a particular state footprint or an unprovided licence number.
- **All twelve listed markets are direct appointments.** Appointment status is confirmed;
  permission to display each third-party logo remains a separate, unresolved question.
- **The one-business-day response, no-broker-fee commitment now and at renewal, and listed
  assessment deliverables are confirmed.** Preserve the personalized recommendation, gap
  analysis, available-market comparison and board-ready summary. These commitments do not
  make a form submission a binder or guarantee underwriting acceptance or savings.
- **ACORD producer-contact information must identify the company, not a person.** The contact
  name is HOA Insurance Agency LLC; founder and staff identity remain separate.

Agency socials (in `constants.ts` → `SOCIAL`, and in the organization `sameAs`): Instagram
`@hoainsuranceagency` · Facebook · LinkedIn `company/hoa-insurance-agency`. Founder profiles are
maintained separately in `FOUNDER_PROFILES`: LinkedIn, Instagram, GitHub, eXp Realty, the Realtor
member directory and Realtor.com.

---

## 10. Forms & lead flow

Five separate lead-capture surfaces:

| Component | Used on | Purpose |
| --- | --- | --- |
| `ContactForm.tsx` | `/`, `/what-we-do`, `/about-us`, `/why-choose-us`, state + city pages | General contact |
| `CoverageCalculator.tsx` | `/` | Interactive coverage estimator |
| `InstantAssessment.tsx` | `/get-started/*` | Ad-landing assessment funnel |
| `AssociationLeadForm.tsx` | `/associations/*` | HO-6 quote, pre-filled with property |
| `QuoteApp.tsx` | `/quote` | Multi-step quote wizard (`client:only`) |

Each submission can fan out to three destinations, all independent:

1. **Website-lead email** via FormSubmit → `https://formsubmit.co/ajax/sales@protectmyhoa.com`
2. **CRM** via AppSync ([`lib/crmLead.ts`](../web/src/lib/crmLead.ts)) — skipped silently if `PUBLIC_CRM_API_URL` / `PUBLIC_CRM_API_KEY` are unset
3. **Zapier** webhooks — one per form type (`PUBLIC_ZAPIER_HOOK_HO6`, `_QUOTE`, `_LEAD`)

The production recipient comes from `AGENCY.leadEmail` in `shared/agency.ts`, consumed by
`FORMSUBMIT_URL` in `web/src/constants.ts`. `insurance@protectmyhoa.com` remains the
general/service/ACORD address; it is not the website-lead recipient.

**Release gate:** FormSubmit must be activated separately for every recipient. Activation of
`insurance@protectmyhoa.com` or a staging address does not activate `sales@protectmyhoa.com`.
Do not deploy production until `sales@protectmyhoa.com` is activated and tested by the user.
The first submission to an unactivated recipient triggers a confirmation email, not a delivered
lead; the recipient must follow that confirmation before delivery can be tested. No real forms
were submitted during this repository pass.

`PUBLIC_LEAD_NOTIFY_EMAIL` may override the recipient for staging or branch previews. Keep
production unset or set to `sales@protectmyhoa.com`, activate any override recipient separately,
and disable analytics for test submissions to avoid recording test conversions.

---

## 11. Environment variables

From [`web/.env.example`](../web/.env.example). The public site builds and renders without
these variables; the separate Buildium sync requires its two credentials and fails closed if
either is absent.

| Variable | Effect if unset |
| --- | --- |
| `PUBLIC_GOOGLE_PLACES_KEY` | Address autocomplete disabled |
| `PUBLIC_CRM_API_URL` / `PUBLIC_CRM_API_KEY` | Forms skip the CRM write, still send email |
| `PUBLIC_LEAD_NOTIFY_EMAIL` | Website leads use `sales@protectmyhoa.com`; overrides need separate FormSubmit activation |
| `PUBLIC_ANALYTICS_DISABLED` | **Analytics ON** (see below) |
| `PUBLIC_ZAPIER_HOOK_HO6` / `_QUOTE` / `_LEAD` | No Zapier routing |
| `PUBLIC_OWNER_LOOKUP_URL` | Owner lookup falls through gracefully |
| `BUILDIUM_CLIENT_ID` / `BUILDIUM_CLIENT_SECRET` | Required for `npm run sync`; never bundled in the website |

### The analytics kill switch

`PUBLIC_ANALYTICS_DISABLED` is **on by default** — production needs no configuration, so analytics can never be lost to a forgotten variable. Set it to exactly `"true"` on the **staging** Amplify app and branch previews so test leads cannot register conversions against the live campaign or pollute Clarity.

**Local development:** the file comment says to leave it unset locally. That means **analytics tags are live on your local pages.** Read-only browsing is harmless, but if you plan to submit a test lead, create `web/.env` with `PUBLIC_ANALYTICS_DISABLED=true` first.

---

## 12. Build & deploy

```sh
cd web && npm install
npm run dev      # → http://localhost:4321
npm run build    # → web/dist  (155 pages, ~1s)
npm run typecheck # Astro template diagnostics + TypeScript check
npm run preview
npm run sync     # regenerate data/properties.json from Buildium
```

Astro config: `site: "https://www.protectmyhoa.com"`, **`trailingSlash: "always"`**, `output: "static"`, `redirects: { "/home": "/" }` (the legacy Squarespace URL — see §3), integrations `@astrojs/react` + `@astrojs/sitemap`. The sitemap filter is now two predicates — `!isNoindexRoute(page)` from [`data/routes.ts`](../web/src/data/routes.ts) and `!isUnreviewedStatePage(page)` from `reviewedStateSlugs` — rather than a hardcoded `/associations/` check. See §3 and §5.

Deploy via [`amplify.yml`](../amplify.yml) — two `applications` entries keyed on `appRoot`. Each Amplify app sets `AMPLIFY_MONOREPO_APP_ROOT` to `web` or `crm`. The `web` app is frontend-only: `npm ci` → `npm run build` → publish `dist/`.

Both Amplify jobs install and select Node 22; the web package requires Node **22.12.0 or
newer**, with `web/.nvmrc` selecting 22. The release migration follows Astro's official
[v6 guide](https://docs.astro.build/en/guides/upgrade-to/v6/) and
[v7 guide](https://docs.astro.build/en/guides/upgrade-to/v7/): Astro **7.3.1**, official React
integration **6.0.5**, and sitemap integration **3.7.4**. A normal dependency update resolved
SVGO to **4.1.0**, without advisory suppression or a forced audit fix. Web production and full
dependency audits report **zero findings** for this lockfile.

`dist/` is gitignored.

---

## 13. Known issues

Repository findings and their resolution are recorded below. External release actions are
listed separately; code changes and local verification do not complete those actions.

> **Closed since the 2026-08-06 pass:** *Google Ads conversions never fire* (fixed by `is:inline` in `Analytics.astro`), *No GA4 anywhere* (added 2026-08-11), and *Analytics snippet duplicated 4×* (consolidated into one component). See §1 and §5. The numbering below keeps the surviving items.

> **Closed in the 2026-09-07 pass, with their numbers kept so nothing else shifts:** item **1**
> (homepage guide count) now derives from `reviewedStateSlugs`. Item **2**
> (the footprint claim disagreeing across four surfaces) — one `AGENCY.areaServed` sentence and
> one `Country` node now, §7. Item **3** (`/quote` in the sitemap with zero crawlable content)
> and item **4** (eight ad landers in the organic sitemap) — both routes are now on the shared
> noindex list, §3. Their entries below are left in place, struck through in substance by this
> note, because each one names the file and the reasoning that a future change would have to
> re-argue.

1. **CLOSED — homepage guide count.** [`index.astro`](../web/src/pages/index.astro) now sets
   `withGuides = reviewedStateSlugs`; the guide count reflects
   reviewed state guides, not all 51 jurisdictions. Nationwide licensing remains unchanged.

2. **CLOSED — footprint disagreement across four surfaces.** Historical evidence, before the shared nationwide facts were adopted:

   | Surface | Says |
   | --- | --- |
   | [`index.astro:36`](../web/src/pages/index.astro#L36) figure | "Licensed in 50 states" — omits DC |
   | `/`, `/contact`, `/what-we-do` body copy | "all 50 states and the District of Columbia" |
   | [`Layout.astro:50-57`](../web/src/layouts/Layout.astro#L50-L57) JSON-LD `areaServed` | 6 states — on **every** page |
   | [`get-started/[...slug].astro:18`](../web/src/pages/get-started/%5B...slug%5D.astro#L18) | "Serving MA, RI, NH, CT, NY, and OK" |
   | [`CoverageCalculator.tsx:46-48`](../web/src/components/CoverageCalculator.tsx#L46-L48) | 6-state map; rejects any other state at [`:349`](../web/src/components/CoverageCalculator.tsx#L349) |

   The quote wizard and calculator now both accept all 51 jurisdictions; the old six-state rejection no longer applies.

3. **CLOSED — `/quote` indexing.** The client-only quote wizard is now noindex and excluded
   from the sitemap. Its lack of a server-rendered H1 is not an organic-indexing release issue.

4. **CLOSED — ad landing pages in the organic sitemap.** `/get-started/*` is now noindex and
   excluded from the sitemap, leaving reviewed `/hoa-insurance-{state}/` guides as organic targets.

5. **Optional title-length review.** The previous four-title finding is stale: the current
   decoded titles are `/about-us` **59**, `/` **71**, `/why-choose-us` **70**, and `/contact`
   **43** characters. The two longer titles can be reviewed separately; character count alone
   does not establish a search-result defect, and this release preserves their intended copy.

6. **Optional title-separator consistency.** `/quote` uses `·` while public marketing titles
   generally use `—`; the quote page is noindex, so this is not an indexing release blocker.

7. **Optional city-title consistency.** "HOA Insurance in New York City" and "HOA Insurance in
   Oklahoma City" omit the state abbreviation used by the other city titles. Their distinct
   canonical routes remain intact; changing this copy is outside the focused release pass.

8. **Optional state/city content review.** `/hoa-insurance-new-york/` and
   `/hoa-insurance-new-york-city-ny/` target different geographic scopes. Similar title wording
   alone does not establish search cannibalization; review performance evidence before changing
   either established route or title.

9. **CLOSED — stale SEO baseline.** `web/seo-baseline.json` was regenerated from the final
   reviewed production build on 2026-09-07. The cross-platform comparison passes for **156
   HTML files**: 155 content pages plus the legacy `/home/` redirect page. See §14.

10. **Buildium credential rotation remains external.** The hardcoded fallback values have been
removed from `web/scripts/sync-buildium.ts`; the script now requires environment variables and
fails closed when either is absent. The values remain exposed in git history, so rotation and any
history remediation still require external action. See [`docs/audit/INVENTORY.md`](audit/INVENTORY.md) §6.

11. **CLOSED — shared hero media loading.** `hero-video.mp4` is now **2,150,912 bytes**
   (about 2.15 MB), down from **28,343,177 bytes** — a **92.4% reduction**. The existing poster
   is shown immediately. Desktop video is attached only after a user's first pointer/key
   interaction; viewports at or below 768px, reduced-motion users, and data-saver users stay
   on the poster. Terms and Privacy have no video prop and never request the video. This
   removes the video from the initial-load/LCP path without replacing the intended desktop
   motion experience.

### Known issues / external dependencies

These actions remain with the user or outside service owners. They are not completed by this
repository pass, and no real forms, credential rotations, console changes, or outside contacts
were performed here.

- **Rotate Buildium credentials** and put replacements in the appropriate Amplify environment
  before deployment. Removing source fallbacks does not revoke exposed credentials; review
  Git history and other local worktree copies separately.
- **Activate and test `sales@protectmyhoa.com` with FormSubmit** before production deployment.
  Every recipient requires its own activation; see §10.
- **Change the apex redirect from 302 to permanent 301/308** at the hosting/CDN layer, pointing
  `https://protectmyhoa.com/` to `https://www.protectmyhoa.com/` and preserving path/query.

Other external records and permissions:

1. **Massachusetts licensing address is stale.** The MA licensing record still shows *11 Apex
   Drive, Suite 300A, Box 1067* while every surface in this repo, the JSON-LD `PostalAddress` and
   the Google Business Profile show 420 Lakeside Ave, Suite 202. NAP consistency is a local-SEO
   signal and a regulatory record at the same time — fixing it is a filing with the MA Division
   of Insurance, not an edit here.

2. **New York registered-agent listing shows Albany.** This is a legal service address, not
   necessarily a business-address defect or a required filing change. Keep its purpose distinct
   from the agency office; do not treat it as another office in site identity data.

3. **An obsolete Squarespace origin is still live.** `hoa-insurance-agency.squarespace.com`
   still serves. A second live host carrying older copy is a duplicate-content and
   entity-confusion source that no canonical on `www.protectmyhoa.com` can suppress, because the
   Squarespace pages carry their own. Retire or redirect it at Squarespace.

4. **ProtectMyHOA trade name unverified.** No supplied filing or licence record establishes it as
   a registered trade name in an insurance jurisdiction. Copy must present it as a brand of the
   licensed agency until a filing number exists. Visible `™` is a separate mark claim;
   `®` requires independently confirmed federal trademark registration.

5. **`jakegreasley.com` does not resolve** (NXDOMAIN, checked 2026-09-07). Until it serves,
   `lib/seo.ts` anchors the founder `Person` to `/about-us/#jake-greasley` while retaining the six
   approved third-party `sameAs` profiles. When the personal site is live, the future entity home
   is the apex URL `https://jakegreasley.com/#person` — never the `www` variant.

6. **Third-party logo permissions remain unconfirmed.** The user confirmed direct appointments
   with all twelve listed markets on 2026-09-07. That does not itself establish permission to
   reproduce each mark in the current display; review the applicable brand guidelines or obtain
   approval. Brian Cole's title and the service commitments are now confirmed in §9.

---

## 14. Pre-commit verification procedure

Use the cross-platform [`web/scripts/seo-fingerprint.mjs`](../web/scripts/seo-fingerprint.mjs)
to compare generated SEO fields with the tracked [`web/seo-baseline.json`](../web/seo-baseline.json).
The PowerShell entry point is a compatibility wrapper around the same implementation, not a
second fingerprint algorithm.

```sh
# Build, then compare with the reviewed baseline.
npm --prefix web run build
npm --prefix web run seo:check

# Only after reviewing and accepting intentional SEO changes:
npm --prefix web run seo:save
npm --prefix web run seo:check
```

The release baseline was regenerated and comparison passed on **2026-09-07**, covering **156
HTML files** (155 content pages plus the `/home/` redirect). Do not use `seo:save` merely to
silence an unexpected difference: inspect the affected page, canonical,
robots directive, H1 count, and structured data first. Keep the resulting baseline in version
control so future comparisons start from the same accepted state.

Also inspect the generated sitemap and robots file. The reviewed site currently has **35
sitemap URLs**, with no noindex page in the sitemap; additions/removals must be deliberate.
The 64 private association pages intentionally have no canonical, Open Graph URL, or agency
graph and stay noindex. A fingerprint match establishes only that the tracked SEO fields
match the accepted build; it does not guarantee rankings or verify live host redirects.

### Final release verification — 2026-09-07

- Web production build and `astro check && tsc --noEmit`: **pass**, with zero errors or
  warnings (six informational hints). CRM frontend and backend type checks: **pass**.
- Complete CRM suite: **88 files, 1,758 tests passed**. Amplify synthesis: **one stack passed**,
  with existing CDK/auth warnings; nothing deployed.
- Generated HTML/canonical/schema/robots/sitemap/noindex checks: **pass** — 91 graph-bearing
  pages, 64 intentionally private pages, 120 noindex pages, and 35 sitemap URLs with no
  noindex overlap. 78 pages use the deferred poster-first video; legal pages contain no video.
- Browser checks at **1280px desktop** and **390px mobile** confirmed zero MP4 requests on
  initial desktop, mobile, and legal views, with one request only after desktop playback.
  Reduced-motion/data-saver behavior is covered by 16 dedicated regression cases, not by
  OS-level emulation. Existing poster sizes are 298,557 bytes (homepage) and 230,374 bytes
  (About/shared legal); the video preserves the 16.5-second shot at 720p with no audio.
- Both production dependency audits: **zero findings**. The full web audit is also clean;
  25 CRM development-tool findings, including **one critical**, remain separately reviewed in
  [`DEPENDENCY-REVIEW.md`](audit/DEPENDENCY-REVIEW.md), not hidden by the production totals.
- Value-safe secret scan: **1,176 files**, including 220 built files, with no known old
  credentials in the active deployment worktree and no additional credential-pattern matches.
  The identified credential copy in a separate local `.claude` worktree remains unchanged;
  rotation is still required.
- Live read-only redirect checks: www homepage **200**, slashless About **301** to its **200**
  canonical URL, and apex still **302** to www. The generated `/home/` file is a static meta
  refresh, not proof of a host-level HTTP 301; permanent host redirects are external settings.

Finish the external release actions in §13 before deployment. Verification does not authorize
submitting real forms, changing external settings, committing, or pushing.
