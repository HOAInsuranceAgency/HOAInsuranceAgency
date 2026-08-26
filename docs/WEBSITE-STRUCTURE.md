# Website Structure & SEO Reference — protectmyhoa.com

**Purpose:** a pre-edit reference for updating site content **without disturbing the SEO surface that is currently producing organic leads.**

Generated from a full read of `web/` plus a production build (`npm --prefix web run build`) on 2026-08-13.
All page counts, titles, and URLs in this document were extracted from the built `dist/` output — they are what the site actually ships, not what the templates suggest.

> **Revised 2026-08-13.** Three things changed under this document since the 2026-08-06 pass and are now folded in: GA4 was added and the broken conversion tag was fixed (§1), `states.ts` grew from 6 states to all 50 plus DC and the site went from 107 pages to 153 (§3), and `/contact` became a real route (§4). Every figure below was re-measured against a fresh build.

---

## Contents

1. [Read this first — the analytics situation](#1-read-this-first--the-analytics-situation)
2. [Repository layout](#2-repository-layout)
3. [Page inventory](#3-page-inventory)
4. [Complete title list](#4-complete-title-list)
5. [Where the SEO lives](#5-where-the-seo-lives)
6. [Edit safety classification](#6-edit-safety-classification)
7. [Structured data](#7-structured-data)
8. [Internal link graph](#8-internal-link-graph)
9. [Agency identity (NAP)](#9-agency-identity-nap)
10. [Forms & lead flow](#10-forms--lead-flow)
11. [Environment variables](#11-environment-variables)
12. [Build & deploy](#12-build--deploy)
13. [Known issues](#13-known-issues)
14. [Pre-commit verification procedure](#14-pre-commit-verification-procedure)

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

- `ContactForm.tsx` fires **no** conversion — the only one of the five lead surfaces that doesn't. See INVENTORY §1.5.
- The kill switch is on by default; staging must set `PUBLIC_ANALYTICS_DISABLED=true`. See §11.

---

## 2. Repository layout

Monorepo, two independently deployed Amplify apps:

| App | Path | Stack | SEO relevant? |
| --- | --- | --- | --- |
| Marketing site | `web/` | Astro 5.18 static + React islands | **Yes — this is the whole public site** |
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
│   └── images/                 # incl. hero-video.mp4 (28 MB)
├── scripts/
│   └── sync-buildium.ts        # generates data/properties.json
└── src/
    ├── constants.ts            # measurement IDs, analytics switch, conversion fn,
    │                           #   nav links, socials
    ├── layouts/
    │   └── Layout.astro        # THE SEO HEAD for 35 of 44 indexable pages
    ├── pages/                  # 12 templates → 153 pages
    ├── components/
    │   ├── Navbar.astro, Footer.astro, Hero.astro, HeroLookup.astro
    │   ├── Analytics.astro     # the ONLY analytics block; all 4 heads import it
    │   ├── CoverageMap.astro   # build-time TopoJSON map; links all 51 states
    │   ├── ContactForm.tsx, CoverageCalculator.tsx
    │   ├── InstantAssessment.tsx, AssociationLeadForm.tsx
    │   ├── QuoteApp.tsx
    │   └── quote/              # schema, session, submission, ui, icons, theme
    ├── data/
    │   ├── states.ts           # 51 state pages — 6 reviewed, 45 noindex
    │   ├── cities.ts           # 22 city pages
    │   ├── landing-pages.ts    # 8 get-started pages
    │   ├── markets.ts          # 12 carrier logos, shared by 2 pages
    │   ├── process.ts          # the 4 placement stages, shared by 2 pages
    │   └── properties.json     # 64 association pages
    ├── lib/crmLead.ts          # web → CRM AppSync write
    └── styles/                 # global.css, quote.css + per-page CSS
```

---

## 3. Page inventory

**153 HTML pages** from **12 templates**. 44 indexable, 109 deliberately hidden.

| Group | Count | Template | Data source | In sitemap |
| --- | --- | --- | --- | --- |
| Static pages | 8 | one `.astro` each | hand-written | Yes |
| State pages — reviewed | 6 | `hoa-insurance-[state].astro` | `states.ts` (`reviewed: true`) | Yes |
| State pages — pending | 45 | same template | `states.ts` (`reviewed: false`) | **No — noindex** |
| City pages | 22 | `hoa-insurance-[city]-[stateAbbr].astro` | `cities.ts` | Yes |
| Get-started landers | 8 | `get-started/[...slug].astro` | `landing-pages.ts` | Yes |
| Association pages | 64 | `associations/[slug].astro` | `properties.json` | **No — noindex** |
| **Total** | **153** | | | **44 indexed** |

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
2. Sitemap exclusion via `reviewedStateSlugs` —
   [`astro.config.mjs:13-21`](../web/astro.config.mjs#L13-L21)

**Flipping a state to `reviewed: true` indexes it and adds it to the sitemap in one edit.**
Only do that once its own statute, market and exposure detail has been written and reviewed.

### The 64 association pages are hidden on purpose

Private, property-manager-distributed HO-6 links generated by the Buildium sync. **Three independent guards — all must stay:**

1. `<meta name="robots" content="noindex, nofollow">` + `<meta name="googlebot" ...>` — [`associations/[slug].astro:42-43`](../web/src/pages/associations/%5Bslug%5D.astro#L42-L43)
2. `Disallow: /associations/` — [`web/public/robots.txt:3`](../web/public/robots.txt#L3)
3. Sitemap exclusion filter — [`web/astro.config.mjs:12`](../web/astro.config.mjs#L12)

### robots.txt

```
User-agent: *
Allow: /
Disallow: /associations/

Sitemap: https://www.protectmyhoa.com/sitemap-index.xml
```

---

## 4. Complete title list

### Static pages (8)

Lengths are decoded character counts (`&amp;` counted as one character).

| URL | `<title>` | Len |
| --- | --- | --- |
| `/` | HOA Insurance for Condominium Associations & Unit Owners — ProtectMyHOA | 71 |
| `/about-us` | About HOA Insurance Agency — Independent HOA & Condo Insurance Brokerage | 72 |
| `/what-we-do` | HOA Insurance & HO-6 Coverage — ProtectMyHOA | 44 |
| `/why-choose-us` | Why Choose HOA Insurance Agency — Specialists in HOA & Condo Insurance | 70 |
| `/contact` | Contact HOA Insurance Agency — HOA & Condo Insurance Specialists | 64 |
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

### Get-started landing pages (8) — `landing-pages.ts` → `metaTitle`

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

[`web/src/layouts/Layout.astro`](../web/src/layouts/Layout.astro) is the single `<head>` for **35 of 44** indexable pages (80 of the 153 built). It owns:

- `<title>`, `<meta name="description">`
- `<link rel="canonical">` — built as `https://www.protectmyhoa.com` + `canonicalPath`
- Open Graph: `og:type`, `og:title`, `og:description`, `og:image`, `og:url`, `og:site_name`
- Twitter: `summary_large_image` card + title/description/image
- The `InsuranceAgency` JSON-LD block
- Both analytics tags

Pages feed it five props: `title`, `description`, `canonicalPath`, `jsonLd`, `noindex`.

`noindex` is opt-in and defaults to false, so the pages that already used this layout were
unaffected when it was added. Its only caller is the state template, which passes
`!state.reviewed` — see §3.

### Three templates bypass the layout

`/quote`, `/get-started/*`, and `/associations/*` each hand-roll their own `<html>`/`<head>`.

**The analytics block is no longer duplicated.** All four heads now import the same
[`components/Analytics.astro`](../web/src/components/Analytics.astro), which reads its
measurement IDs from `constants.ts`. A tag change is one edit in one file.

| File | Analytics |
| --- | --- |
| [`layouts/Layout.astro`](../web/src/layouts/Layout.astro#L81) | `<Analytics />` |
| [`pages/quote.astro`](../web/src/pages/quote.astro#L23) | `<Analytics />` |
| [`pages/get-started/[...slug].astro`](../web/src/pages/get-started/%5B...slug%5D.astro#L63) | `<Analytics />` |
| [`pages/associations/[slug].astro`](../web/src/pages/associations/%5Bslug%5D.astro#L52) | `<Analytics />` |

What the bypass still costs, verified in the built HTML:
- `/quote` and `/get-started/*` have **no Twitter card and no `og:image`**.
- `/associations/*` has **no canonical and no JSON-LD** (fine — it is noindex).

### Heading structure (verified in built HTML)

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

### 🔴 DO NOT CHANGE — URLs and ranking signals

| What | Where |
| --- | --- |
| `slug` fields | `states.ts`, `cities.ts`, `landing-pages.ts` — **these ARE the URLs** |
| Filenames in `src/pages/` | renaming = new URL = lost ranking |
| `title` / `description` | `states.ts`, `cities.ts` |
| `metaTitle` / `metaDescription` | `landing-pages.ts` |
| `title=` / `description=` / `canonicalPath=` props | the 8 static pages |
| `faqJsonLd` blocks | [`index.astro:33-50`](../web/src/pages/index.astro#L33-L50), [`what-we-do.astro:33-47`](../web/src/pages/what-we-do.astro#L33-L47) |
| `baseSchema` | [`Layout.astro:28-57`](../web/src/layouts/Layout.astro#L28-L57) |
| The `<head>` of `Layout.astro` | canonical / OG / Twitter machinery |
| `robots.txt`, `astro.config.mjs` | crawl directives + sitemap filter |
| The association noindex guards | see §3 |
| `reviewed: true/false` in `states.ts` | flips both indexing and sitemap inclusion — see §3 |

### 🟡 CAREFUL — H1s, link graph, NAP

- **`heroTitle`** (states/cities) and **`headline`** (landing-pages) render as the **H1**. Editable, but keep the primary keyword — H1 is a genuine ranking signal.
- **`cities: [...]`** array in `states.ts` drives state→city internal links. Removing a name orphans that city page from its hub.
- **Phone / email / address** live in [`shared/agency.ts`](../shared/agency.ts) and feed the JSON-LD `PostalAddress`. This is your NAP consistency for local SEO — it must keep matching your Google Business Profile.
- **FAQ answer text** on `/` and `/what-we-do` is *both* visible copy and `FAQPage` schema — the same array feeds both. Rewording changes your rich-result markup. Treat as 🔴.

### 🟢 SAFE — pure content

- All body copy in the 8 static pages (everything below the `<Layout ...>` props)
- `intro`, `regulations`, `hoaTypes` in `states.ts`
- `subheadline`, `trustSignals`, `urgencyText` in `landing-pages.ts`
- `Hero` `subtitle` and `eyebrow` props
- The content arrays: `COVERAGES`, `STEPS`, `CLIENT_TYPES` (index), `MASTER_COVERAGES`, `COMMON_ISSUES`, `HO6_COVERAGES` (what-we-do)
- All CSS files, all images

---

## 7. Structured data

### `InsuranceAgency` — every page via `Layout.astro`

```
@type:       InsuranceAgency
name:        HOA Insurance Agency
url:         https://www.protectmyhoa.com
telephone:   +1-508-233-2261        (derived from shared/agency.ts)
email:       insurance@ProtectMyHOA.com
address:     420 Lakeside Ave, Suite 202, Marlborough, MA 01752, US
areaServed:  MA, RI, NH, CT, NY, OK   (6 × @type: State)
sameAs:      Instagram, Facebook, LinkedIn
description: Independent insurance brokerage specializing in HOA master
             insurance policies and HO-6 condo unit owner coverage.
```

`/get-started/*` emits its own trimmed copy (no `areaServed`, no `sameAs`) at [`get-started/[...slug].astro:86-101`](../web/src/pages/get-started/%5B...slug%5D.astro#L86-L101).

### `FAQPage` — 2 pages only

Your highest-value and most fragile SEO asset — rich-result eligible.

| Page | Questions | Source |
| --- | --- | --- |
| `/` | 6 | [`index.astro:33-50`](../web/src/pages/index.astro#L33-L50) |
| `/what-we-do` | 3 | [`what-we-do.astro:33-47`](../web/src/pages/what-we-do.astro#L33-L47) |

Homepage questions: what is HOA master insurance · master vs HO-6 · do unit owners need HO-6 · what states served · how much does it cost · what to review at renewal.

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
  indexed, but its only internal link is now the "About our brokerage" link in the
  homepage practice section. Do not remove that link without restoring the nav path.
- **"Contact" is a real route** (`/contact`), no longer the `/#contact` anchor.

`NAV_LINKS` intentionally omits `/quote` and `/get-started`; the quote CTA is rendered
separately.

**Note:** no page links to `/get-started/*` — those 8 pages are reachable only from ads and the sitemap. That is by design for paid traffic, but it means they receive no internal link equity.

---

## 9. Agency identity (NAP)

Single source of truth: [`shared/agency.ts`](../shared/agency.ts). Deliberately dependency-free so Astro pages, React islands, the Vite SPA, and Vitest can all import it.

| Field | Value |
| --- | --- |
| Legal name | HOA Insurance Agency LLC |
| Producer contact | Jake Greasley |
| Address | 420 Lakeside Ave, Suite 202, Marlborough, MA 01752 |
| Phone | 508-233-2261 |
| Email | insurance@ProtectMyHOA.com (canonical mixed case) |

`AGENCY_FMT` derives every reformatted variant — `tel:` href, E.164, schema.org `telephone`, footer address line, FormSubmit endpoint. **Edit `AGENCY` only; never hand-edit `AGENCY_FMT`.** One edit updates both the ACORD forms and the website footer.

Socials (in `constants.ts` → `SOCIAL`, and in the JSON-LD `sameAs`): Instagram `@hoainsuranceagency` · Facebook · LinkedIn `company/hoa-insurance-agency`.

---

## 10. Forms & lead flow

Four separate lead-capture surfaces:

| Component | Used on | Purpose |
| --- | --- | --- |
| `ContactForm.tsx` | `/`, `/what-we-do`, `/about-us`, `/why-choose-us`, state + city pages | General contact |
| `CoverageCalculator.tsx` | `/` | Interactive coverage estimator |
| `InstantAssessment.tsx` | `/get-started/*` | Ad-landing assessment funnel |
| `AssociationLeadForm.tsx` | `/associations/*` | HO-6 quote, pre-filled with property |
| `QuoteApp.tsx` | `/quote` | Multi-step quote wizard (`client:only`) |

Each submission can fan out to three destinations, all independent:

1. **Email** via FormSubmit → `https://formsubmit.co/ajax/insurance@protectmyhoa.com`
2. **CRM** via AppSync ([`lib/crmLead.ts`](../web/src/lib/crmLead.ts)) — skipped silently if `PUBLIC_CRM_API_URL` / `PUBLIC_CRM_API_KEY` are unset
3. **Zapier** webhooks — one per form type (`PUBLIC_ZAPIER_HOOK_HO6`, `_QUOTE`, `_LEAD`)

Because these are independent, the broken gtag conversion does not affect lead delivery.

---

## 11. Environment variables

From [`web/.env.example`](../web/.env.example). All are optional — the site builds and renders without any of them.

| Variable | Effect if unset |
| --- | --- |
| `PUBLIC_GOOGLE_PLACES_KEY` | Address autocomplete disabled |
| `PUBLIC_CRM_API_URL` / `PUBLIC_CRM_API_KEY` | Forms skip the CRM write, still send email |
| `PUBLIC_ANALYTICS_DISABLED` | **Analytics ON** (see below) |
| `PUBLIC_ZAPIER_HOOK_HO6` / `_QUOTE` / `_LEAD` | No Zapier routing |
| `PUBLIC_OWNER_LOOKUP_URL` | Owner lookup falls through gracefully |
| `BUILDIUM_CLIENT_ID` / `_SECRET` | Only used by `npm run sync`, never bundled |

### The analytics kill switch

`PUBLIC_ANALYTICS_DISABLED` is **on by default** — production needs no configuration, so analytics can never be lost to a forgotten variable. Set it to exactly `"true"` on the **staging** Amplify app and branch previews so test leads cannot register conversions against the live campaign or pollute Clarity.

**Local development:** the file comment says to leave it unset locally. That means **analytics tags are live on your local pages.** Read-only browsing is harmless, but if you plan to submit a test lead, create `web/.env` with `PUBLIC_ANALYTICS_DISABLED=true` first.

---

## 12. Build & deploy

```sh
cd web && npm install
npm run dev      # → http://localhost:4321
npm run build    # → web/dist  (153 pages, ~4.0s)
npm run preview
npm run sync     # regenerate data/properties.json from Buildium
```

Astro config: `site: "https://www.protectmyhoa.com"`, `output: "static"`, integrations `@astrojs/react` + `@astrojs/sitemap` (with the `/associations/` filter).

Deploy via [`amplify.yml`](../amplify.yml) — two `applications` entries keyed on `appRoot`. Each Amplify app sets `AMPLIFY_MONOREPO_APP_ROOT` to `web` or `crm`. The `web` app is frontend-only: `npm ci` → `npm run build` → publish `dist/`.

`dist/` is gitignored.

---

## 13. Known issues

Recorded for awareness. **None should be fixed as part of a content pass** — each is a separate, measurable change.

> **Closed since the 2026-08-06 pass:** *Google Ads conversions never fire* (fixed by `is:inline` in `Analytics.astro`), *No GA4 anywhere* (added 2026-08-11), and *Analytics snippet duplicated 4×* (consolidated into one component). See §1 and §5. The numbering below keeps the surviving items.

1. **The homepage state count renders wrong.** [`index.astro:96`](../web/src/pages/index.astro#L96) sets `withGuides = states` — all 51 — so §11 of the page reads *"Licensed in all 50 states and the District of Columbia, with dedicated guides for the 51 where we place the most association business."* It should count the reviewed states only; `reviewedStateSlugs` already exists at [`states.ts:232`](../web/src/data/states.ts#L232). Introduced when `states.ts` grew from 6 to 51.

2. **The footprint claim disagrees across four surfaces.** A direct consequence of the same growth — the state data expanded, the things that describe it did not:

   | Surface | Says |
   | --- | --- |
   | [`index.astro:36`](../web/src/pages/index.astro#L36) figure | "Licensed in 50 states" — omits DC |
   | `/`, `/contact`, `/what-we-do` body copy | "all 50 states and the District of Columbia" |
   | [`Layout.astro:50-57`](../web/src/layouts/Layout.astro#L50-L57) JSON-LD `areaServed` | 6 states — on **every** page |
   | [`get-started/[...slug].astro:18`](../web/src/pages/get-started/%5B...slug%5D.astro#L18) | "Serving MA, RI, NH, CT, NY, and OK" |
   | [`CoverageCalculator.tsx:46-48`](../web/src/components/CoverageCalculator.tsx#L46-L48) | 6-state map; rejects any other state at [`:349`](../web/src/components/CoverageCalculator.tsx#L349) |

   The quote wizard was already fixed for this — [`quote/schema.ts:83-85`](../web/src/components/quote/schema.ts#L83-L85) derives its state list from `states.ts`. The calculator was not, so a visitor arriving from `/hoa-insurance-texas` is told the agency does not serve their state.

3. **`/quote` is in the sitemap with zero crawlable content.** H1=0, H2=0, no JSON-LD, no body text — it renders `<QuoteApp client:only="react" />`, so crawlers get an empty shell. Submitted for indexing with nothing to index.

4. **8 ad landing pages are in the organic sitemap.** `/get-started/{state}` targets the same keywords as `/hoa-insurance-{state}` ("Massachusetts HOA insurance"), risking self-competition against the pages actually earning organic leads.

5. **Four titles exceed the ~60-char SERP limit** and are truncated in results: `/about-us` (72), `/` (71), `/why-choose-us` (70), `/contact` (64). Lengths re-measured 2026-08-13 as decoded characters; the earlier figures counted the `&amp;` entity.

6. **`/quote` uses `·` as its title separator** while all 152 other pages use `—`.

7. **Two city titles drop the state abbreviation** — "HOA Insurance in New York City" and "HOA Insurance in Oklahoma City" break the `{City}, {ST}` pattern the other 20 follow. Data inconsistency in `cities.ts`.

8. **Near-duplicate titles:** `/hoa-insurance-new-york` ("...in New York") vs `/hoa-insurance-new-york-city-ny` ("...in New York City") — cannibalization risk between the state hub and its largest city page.

9. **`web/seo-baseline.json` predates the 51-state expansion** and no longer matches a clean build (see §14). Re-save it before using the fingerprint check.

10. **Committed live credentials.** [`web/scripts/sync-buildium.ts:56-60`](../web/scripts/sync-buildium.ts#L56-L60) hardcodes `BUILDIUM_CLIENT_ID` and `BUILDIUM_CLIENT_SECRET` as `||` fallback defaults, while the file's own header documents both as required env vars. Present in the working tree and in git history on `staging`. **Rotating the credentials is the only effective remediation** — deleting the lines does not clear history. Carried over from a previous audit; see [`docs/audit/INVENTORY.md`](audit/INVENTORY.md) §6.

11. **28 MB `hero-video.mp4`** in `public/images/`, loaded on several pages. A Core Web Vitals concern (LCP), which is a ranking factor.

---

## 14. Pre-commit verification procedure

This is how you **prove** a content edit left the SEO surface untouched, rather than hoping it did.

Save the following as `web/seo-fingerprint.ps1`. It was tested on this repo against the then-107 pages — both that it passes on an unchanged build, and that it catches a single tampered `<title>` and names the page. It is page-count agnostic, so it covers all 153 unchanged.

**Your existing baseline is stale.** `web/seo-baseline.json` was captured at 107 pages and the site now builds 153, so a comparison against it flags the 46 added pages as differences. Re-run with `-Save` once before relying on it again.

```powershell
# Fingerprints the SEO-bearing parts of every built page.
#   .\seo-fingerprint.ps1 -Save     → write baseline (run BEFORE editing)
#   .\seo-fingerprint.ps1           → compare against baseline (run AFTER)
param(
  [switch]$Save,
  [string]$Root     = 'web\dist',
  [string]$Baseline = 'web\seo-baseline.json'
)

function Get-SeoFingerprint {
  param([string]$Root)
  # Use .FullName, not $env:TEMP-style paths — 8.3 short names ("CHRIST~1")
  # will not string-match the long form returned by DirectoryName.
  $base = (Get-Item $Root).FullName
  Get-ChildItem -Recurse -Filter index.html $Root | ForEach-Object {
    $c = Get-Content $_.FullName -Raw
    [pscustomobject]@{
      url       = '/' + $_.DirectoryName.Substring($base.Length).TrimStart('\').Replace('\','/')
      # $(if ...) subexpressions are required — PowerShell 5.1 rejects a bare
      # `if` as a hashtable value ("The hash literal was incomplete").
      title     = $(if ($c -match '(?s)<title>(.*?)</title>') { $matches[1] } else { '' })
      desc      = $(if ($c -match '<meta name="description" content="([^"]*)"') { $matches[1] } else { '' })
      canonical = $(if ($c -match '<link rel="canonical" href="([^"]*)"') { $matches[1] } else { '' })
      robots    = $(if ($c -match '<meta name="robots" content="([^"]*)"') { $matches[1] } else { '' })
      h1        = ([regex]::Matches($c,'<h1[^>]*>')).Count
      jsonld    = (([regex]::Matches($c,'(?s)<script type="application/ld\+json">(.*?)</script>') |
                    ForEach-Object { $_.Groups[1].Value }) -join '~')
    }
  } | Sort-Object url
}

$FIELDS = 'url','title','desc','canonical','robots','h1','jsonld'
$current = Get-SeoFingerprint -Root $Root

if ($Save) {
  $current | ConvertTo-Json -Depth 3 -Compress | Out-File $Baseline -Encoding utf8
  "Baseline saved: $($current.Count) pages -> $Baseline"
  return
}

if (-not (Test-Path $Baseline)) { throw "No baseline at $Baseline. Run with -Save first." }
$diff = Compare-Object (Get-Content $Baseline -Raw | ConvertFrom-Json) $current -Property $FIELDS

if ($diff) {
  "SEO CHANGED - $($diff.Count) row(s):"
  $diff | Select-Object SideIndicator,url,title,desc,canonical,robots,h1 | Format-Table -AutoSize -Wrap
  "(<= baseline, => current)"
} else {
  "PASS - SEO surface unchanged across all $($current.Count) pages."
}
```

### Usage

```powershell
# BEFORE you edit
npm --prefix web run build
.\web\seo-fingerprint.ps1 -Save

# ... make your content edits ...

# AFTER you edit
npm --prefix web run build
.\web\seo-fingerprint.ps1
```

Also confirm the sitemap is stable:

```powershell
([xml](Get-Content web\dist\sitemap-0.xml -Raw)).urlset.url.loc.Count   # expect 44
```

**`PASS` means** every title, description, canonical, robots directive, H1 count, and JSON-LD payload on all 153 pages is identical to before your edit. Your organic rankings have nothing to react to.

**If it flags a row**, `SideIndicator` tells you which side changed (`<=` baseline, `=>` current) and `url` names the page — check it against the [edit safety classification](#6-edit-safety-classification) before deciding whether the change was intended.

Add `web/seo-baseline.json` to `.gitignore` if you don't want the baseline committed.

Then land on `staging`, verify on the staging URL, and merge to `main`.
