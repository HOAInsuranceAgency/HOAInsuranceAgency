# Focused release-readiness result — September 7, 2026

The requested repository corrections and local release checks pass. The work is
ready for the user to complete the external release gates below, then commit and
deploy. This is not a blanket security clearance: the CRM build-toolchain audit
still has 25 findings, including one critical, with the inspected exposure and
remaining risk recorded in [DEPENDENCY-REVIEW.md](DEPENDENCY-REVIEW.md).

No commit, push, deployment, credential rotation, console edit, real form
submission, or external outreach was performed.

## Completed changes

- Terms identifies HOA Insurance Agency LLC as an independent insurance agency,
  not an insurance company or carrier. Terms and Privacy retain their January 1,
  2026 effective dates and record September 7, 2026 as Last Updated.
- FormSubmit documentation now matches the production `sales@protectmyhoa.com`
  lead endpoint. General/service/ACORD mail remains separate. Activation is
  required for each recipient, including any explicit environment override.
- The reviewed-guide count is marked closed. The SEO baseline was regenerated
  from the final reviewed build with a cross-platform checker and retained
  PowerShell compatibility wrapper.
- Astro 7.3.1, React integration 6.0.5, sitemap integration 3.7.4, and SVGO 4.1.0
  replace the vulnerable web dependency tree. HTML-aware spacing is explicit;
  encoded trademark props were corrected after browser inspection. Missing map
  types and the generic/state landing-page route type were corrected so the new
  Astro template check passes. Amplify build configuration selects Node 22 for
  both applications; local release checks used Node 22.23.2.
- React Router and React Router DOM are 7.18.3. No force fixes, downgrades, or new
  advisory-suppressing overrides were used.
- Confirmed founder/producer identities, six founder profiles, twelve direct
  appointments, response/no-fee/deliverable commitments, company-only ACORD
  contact identity, testimonials, reviews, and displayed metrics are preserved.

## Hero performance

| Asset | Final bytes | Notes |
| --- | ---: | --- |
| `hero-video.mp4` | 2,150,912 | Previously 28,343,177 bytes; 92.4% smaller. |
| `hero-people.jpg` | 298,557 | Existing poster retained. |
| `about-hero.jpg` | 230,374 | Existing poster retained. |

The video retains the original 16.52-second sequence as a 720p H.264 MP4 with
fast-start metadata and no audio. The eagerly loaded, high-priority poster is
visible immediately. Video has no initial `src`, no autoplay attribute, and
`preload="none"`; desktop playback becomes available after input and has a
play/pause control. This keeps video bytes out of initial rendering and prevents
video from becoming the initial LCP candidate.

At widths of 768px or less, with reduced motion, or with data saver enabled, the
hero stays on the poster. Legal pages render no video element. Live local browser
checks at 1280px and 390px verified the layout and play/pause behavior. Request
logging observed zero additional MP4 requests across mobile, both legal pages,
and an untouched desktop page; desktop Play triggered one MP4 request. Reduced
motion and data-saver changes are covered by regression tests; OS preferences
were not changed for browser testing.

## Verification

| Check | Result |
| --- | --- |
| Clean installs in `web` and `crm` | Pass; lockfiles reproduce the reviewed dependencies. |
| Web `npm run build` | Pass: 155 content pages plus `/home` redirect HTML. |
| Web `npm run typecheck` | `astro check && tsc --noEmit`: 0 errors, 0 warnings, 6 non-blocking hints. |
| CRM `npm run typecheck` | Frontend and backend pass. |
| CRM `npm run test:run` | 88 files, 1,758 tests pass. Includes all 18 ACORD mappings. |
| CRM `npm run build` | Pass; existing large-chunk warning. |
| CRM `npm run synth:check` | Pass: 1 stack; existing CDK deprecation and authorization warnings. No deploy. |
| Web `npm audit --omit=dev` / full audit | 0 / 0 findings. |
| CRM `npm audit --omit=dev` / full audit | 0 / 25 build-toolchain findings; see dependency review. |
| Generated HTML inspection | 91 consistent entity graphs; 64 intentionally bare private association pages; founder/profile, Brian title, canonical/OG/WebPage/FAQ, branding, robots and legal checks pass. |
| Sitemap and indexing | 35 URLs; 120 noindex pages; zero overlap. |
| Hero output | 78 poster-first video pages; zero video elements on Terms/Privacy. |
| `npm run seo:save` then `npm run seo:check` | Baseline matches all 156 HTML files, including redirect. |
| `git diff --check` | Pass. |

The secret scan inspected 1,176 files, including 220 built outputs, without
printing secret values. Neither known exposed Buildium value remains in the
current deployment worktree or built output; additional private-key, AWS-access-key,
GitHub-token, and live-payment-key pattern checks found no matches. This is a
scoped scan, not a guarantee that no conceivable secret exists. It excludes Git
objects and dependency caches. The unchanged separate worktree at
`.claude/worktrees/agitated-shaw-1803ae/web/scripts/sync-buildium.ts` still contains
the old credential copy. Git history also retains the exposed values; neither
was rewritten or removed by this pass.

Read-only live checks confirmed apex `https://protectmyhoa.com/` returns **302**
to the www homepage, the www homepage returns **200**, and `/about-us` returns
**301** to `/about-us/`, which returns **200**. The generated `/home` compatibility
page uses a static meta refresh to `/`; this is not an HTTP redirect status and
does not replace an Amplify/CDN redirect rule.

## External user actions before release

1. **Rotate Buildium credentials** and store replacements in the relevant Amplify
   environment. Working-tree removal does not erase Git history. Handle any
   history or separate-worktree remediation independently and carefully.
2. **Activate and test `sales@protectmyhoa.com` with FormSubmit.** Each recipient
   requires its own activation. Do not deploy production until the sales
   recipient is activated and tested. No real submission was made here.
3. **Change the apex redirect from 302 to permanent 301 or 308** in hosting/domain
   settings, preserving the www canonical destination and relevant paths.
4. **Retire or redirect the old Squarespace origin.**
5. **Correct the Massachusetts licensing address.**
6. **Confirm permissions for all twelve carrier/market logos.** Direct
   appointments are confirmed; logo permission is a separate question.

Jurisdiction-specific ProtectMyHOA trade-name approvals remain a separate
compliance question. The founder's personal-site entity migration remains
deferred until that site serves a successful response with its intended
canonical. Track upstream-compatible remediation of the CRM build-toolchain
findings separately; do not describe the full CRM dependency tree as clean.
