# Carrier logos — section 06 of the homepage

Twelve logos, rendered as a single-line marquee scrolling right to left. Source
artwork came from `crm/CREATIVE/HOME/insurance/`; these files are normalized
copies, so re-derive them from that folder rather than editing them in place.

## Files

Source filenames were abbreviated and inconsistent, so each was renamed to match
the `slug` in the `MARKETS` array in
[`web/src/data/markets.ts`](../../../src/data/markets.ts).

| Carrier | Source | This folder |
| --- | --- | --- |
| Amwins | `awins.png` | `amwins.png` |
| CAIS | `cais.png` | `cais.png` |
| Community Association Underwriters | `cau.png` | `community-association-underwriters.png` |
| CondoLogic | `condo logic.png` | `condologic.png` |
| Distinguished | `dist.png` | `distinguished.png` |
| Greater New York | `gny.png` | `greater-new-york.png` |
| Honeycomb | `honey.png` | `honeycomb.png` |
| LIO Insurance | `lio.png` | `lio-insurance.png` |
| McGowan | `mcgrown.png` | `mcgowan.png` |
| Pathpoint | `pathpoint.png` | `pathpoint.png` |
| RPS | `rps.png` | `rps.png` |
| Travelers | `travelers .png` | `travelers.png` |

## How they were processed

Every file was resized to **120px tall** with its native aspect ratio preserved,
which is 2× the 60px-ish rendered height. Widths therefore vary (152px to 617px)
and that is intentional — forcing a common width would stretch the wide
wordmarks. Uniform *size* comes from CSS instead: each marquee slide is a fixed
200 × 92 box and `object-fit: contain` fits the mark inside it, so every logo
occupies exactly the same footprint undistorted.

No filter, tint or grayscale is applied. Each mark appears in its own colors.

## Adding or replacing a carrier

1. Add the file here using the carrier's slug as the filename.
2. Add an entry to `MARKETS` in `data/markets.ts` with `name` and `slug`.

`MARKETS` moved out of `index.astro` when `/why-choose-us` began rendering the same wall.
Both pages read the one array, so a carrier added here appears on both.

`name` becomes the image's `alt` text. Since the wall shows logos only, that alt
is the sole accessible label for the carrier — keep it accurate.

The marquee renders the list twice and animates to `-50%`; the second copy is
what makes the loop seamless. That is automatic, so no change is needed when the
list length changes.

## Known artwork issue

**`rps.png` is white-on-green.** It is RPS's own lockup on their brand green, so
it renders as a green tile among eleven predominantly white ones. Nothing in the
CSS causes this and recoloring a carrier's mark would be a worse trademark
problem than the visual inconsistency. If it should match the others, request a
version on a transparent or white ground from RPS.

## What the site claims about these carriers

**Confirmed by the user on 2026-09-07:** the agency has direct appointments with
all twelve listed markets. This supersedes the earlier restriction to
market-access wording; copy may describe the confirmed direct appointments.
Availability still varies by state, association type and risk profile, and the
confirmation does not establish a particular market's binding authority.

## Still needs written confirmation

**Permission to reproduce each third-party mark remains unconfirmed.** Direct
appointments do not themselves establish logo permission. Check the applicable
brand guidelines and obtain any approval required for this display.

Re-check appointment status and logo permissions whenever the list changes.
