# ProtectMyHOA Journal: editorial guide

These rules apply to every article on `/blog/`, whether a person or the weekly
automation writes it. The site's build already enforces the technical rules
(see `web/src/lib/article-schema.ts` and the README's "Marketing articles"
section). This guide covers what the build cannot check: scope, accuracy, voice
and structure.

## Scope

Write only about Insurance for HOAs and condominium associations: master
policies, board liability, association property and liability risk, what unit
owners need alongside the master policy, renewals and the market, and the laws
and lender rules that set coverage requirements. Do not write about personal
auto, life, health, commercial lines unrelated to associations, or general
real-estate news.

Articles cover both **national** topics (lender requirements, D&O, market
trends) and **state** topics (new condo and HOA laws, storm deductibles, state
coverage requirements). Any state qualifies; pick by what is in the news and
what people are searching for. A state article names the state in the title,
the slug and the first paragraph.

## Publishing schedule

The journal publishes **2 to 3 articles every week**, one per day on Tuesday,
Wednesday and Thursday. Each category has its own day and time (Eastern), set
for when its readers are most likely to read:

| Category | Day | Time (ET) | Why this slot |
| --- | --- | --- | --- |
| Master Policies | Tuesday | 8:00 AM | Board members read before work, early in the week |
| Laws & Compliance | Tuesday | 10:00 AM | New laws and deadlines lead the week |
| Market & Renewals | Wednesday | 8:00 AM | Managers plan renewals and budgets midweek |
| Property & Catastrophe | Wednesday | 10:00 AM | Storm and flood topics ahead of the weekend |
| D&O and Crime | Wednesday | 12:00 PM | Lunchtime reading for directors |
| Liability & Umbrella | Thursday | 10:00 AM | Property managers during business hours |
| Claims & Risk | Thursday | 12:00 PM | Managers and boards at midday |
| Unit Owners (HO-6) | Thursday | 6:00 PM | Owners read in the evening |

The weeks follow a four-week rotation, three articles a week, one per day:

| Week | Tuesday | Wednesday | Thursday |
| --- | --- | --- | --- |
| 1 | Master Policies, 8:00 AM | Property & Catastrophe, 10:00 AM | Unit Owners (HO-6), 6:00 PM |
| 2 | Laws & Compliance, 10:00 AM | D&O and Crime, 12:00 PM | Claims & Risk, 12:00 PM |
| 3 | Master Policies, 8:00 AM | Market & Renewals, 8:00 AM | Liability & Umbrella, 10:00 AM |
| 4 | Laws & Compliance, 10:00 AM | Property & Catastrophe, 10:00 AM | Unit Owners (HO-6), 6:00 PM |

- **Seasons shift the mix.** From June to November (hurricane season), week 2's
  Wednesday goes to Property & Catastrophe at 10:00 AM instead of D&O and
  Crime. From September to December (budget and renewal season), week 4's
  Wednesday goes to Market & Renewals at 8:00 AM instead of Property &
  Catastrophe. Each swapped article keeps its own category's time.
- **Breaking news takes the next open slot for its category.** A new law goes
  out the following Tuesday at 10:00 AM, for example.
- The automation drafts 3 articles a week, so one can be rejected and the week
  still reaches 2.
- If a news topic fails the accuracy check, the run switches to an evergreen
  topic in the same category rather than skipping the slot.
- Drafts are written ahead with `publishedAt` set to the slot's date and time,
  so reviewers can approve early. A site rebuild runs at every slot time to
  publish each article on schedule. Expect it live within about 15 minutes of
  the slot.
- Mix state and national topics across each week.

## Categories

Set `topic` to exactly one of these names. They are listed in
`web/src/data/blog.ts`, which also sets the page each category links readers to.

| Category | Covers |
| --- | --- |
| Master Policies | Policy forms, valuations, appraisals, what the association insures |
| D&O and Crime | Directors and officers liability, fidelity and crime coverage |
| Liability & Umbrella | General liability, amenities, umbrella limits |
| Property & Catastrophe | Wind, named storm, flood, water damage, deductibles |
| Unit Owners (HO-6) | What owners insure, loss assessment, the unit boundary |
| Market & Renewals | Premium trends, reinsurance, renewal preparation |
| Laws & Compliance | State statutes, inspections and reserves, lender requirements |
| Claims & Risk | Claims process, maintenance and risk reduction |

## Accuracy: no fake or false news

1. Every factual statement is backed by a source in `sources`. A statement with
   no source is removed, not softened.
2. News, laws, deadlines and figures need a primary source (the statute, the
   regulator, the government agency) or two independent industry sources.
3. Open every source URL and confirm it says what the article says. Record the
   date it was checked as `accessedAt`.
4. Do not state premiums, rates, carrier rankings or predictions unless a cited
   source publishes them. Never invent statistics, quotes, people or cases.
5. Name the state wherever a rule is state-specific. Never present one state's
   law as national.
6. If the facts cannot be verified, do not publish the article.

Preferred sources: state insurance departments and legislatures, NAIC, FEMA and
the NFIP, Fannie Mae and Freddie Mac, the Insurance Information Institute,
Community Associations Institute and AM Best.

## Titles: hook, search and trend

The title is the first thing a board member sees in Google. Each draft offers
three options and the reviewer picks one. A good title:

- Opens with the phrase people actually search for, e.g. "HOA master policy".
- Follows what is current: a law taking effect, renewal season, hurricane
  season, a recent storm, a lender rule change, or a rising search term in
  Google Trends or Search Console.
- Uses one of these hooks:
  - **The question boards ask.** "Can HOA Board Members Be Sued Personally?"
  - **The deadline or change.** "Florida's Condo Insurance Deadline: What Boards Must Do Now"
  - **The costly mistake.** "The Deductible Mistake Condo Owners Keep Making"
  - **The plain answer.** "Who Pays for Water Damage in a Condo? The Short Answer"
- Stays under 60 characters where possible. The site adds "| ProtectMyHOA".
- Is fully answered by the article and backed by its sources. No clickbait, no
  false urgency.

The `description` (160 characters or fewer) states what the reader will learn.
The slug is short and keyword-led, e.g. `hoa-board-member-personal-liability`.

## Structure and style

Write in professional US English for board members and property managers.
Explain terms the first time they appear. Use "Insurance" with a capital I in
visible text.

- **Paragraphs only.** No bullet points, no numbered lists and no tables in the
  body. Explain in sentences.
- **Open with an "In brief" summary**: one short paragraph written as a
  blockquote (`> `) on the first line of the body. The page styles it as a
  summary box.
- **Section headings (`##`) for each section**, with `###` only where a section
  truly needs a sub-heading. Never use `#`; the page supplies the title.
- **Three to four paragraphs per section, at most.** Keep paragraphs to two to
  five sentences.
- **Cite as you write.** Link the claim to its source inline, e.g.
  `[Fannie Mae's Selling Guide](https://...)`, and list every source in
  `sources`.
- **Link to the site.** Include at least two links to service pages, such as
  `/what-we-do/`, `/condo-insurance/` or a state page like `/hoa-insurance-florida/`.
- 1,000 to 2,000 words. The build rejects anything outside that range.

The page adds the table of contents, the mid-article call to action, the
sources list, the disclaimer, the lead form and related articles, so the body
never includes them.

## Images

Each article needs a real cover photo, added by the reviewer at approval:

- Landscape, at least 1600 × 900 pixels, JPG, PNG or WebP, under 10 MB.
- A real photo that fits the topic. No carrier logos, and no recognizable faces
  without permission. No AI-generated photos.
- A credit line ("Photo: HOA Insurance Agency" or "Photo: Jane Doe / Unsplash"),
  where it came from and its license (`provenance`), and alt text describing it.

The file goes in `web/public/images/blog/<slug>/`, and its width and height in
the front matter must match the file.

## Byline and review

Articles are published by HOA Insurance Agency. No individual author or license
number appears. Every article is approved by the reviewer before it is merged,
and nothing publishes without that approval.

## How the automation works

The workflows live in `.github/workflows/blog-*.yml` and their scripts in
`.github/blog/`.

1. **Drafting.** Every Monday, Tuesday and Wednesday at 6:00 AM Eastern, the
   "Blog drafts" workflow drafts the article for the following week's Tuesday,
   Wednesday or Thursday slot. It researches the topic, then a separate pass
   opens every source and removes anything it cannot confirm, then the
   structure rules above are checked and the site build is run.
2. **Approval email.** The reviewer receives the title options, the fact-check
   summary, the sources and two links: the draft pull request and the photo
   upload folder.
3. **Review.** In the pull request, the reviewer uploads the cover photo to the
   article's image folder and comments:

   ```
   /title 2
   /photo
   alt: Condominium building exterior on a clear day
   credit: Photo: HOA Insurance Agency
   source: Agency photo, all rights held
   link: https://optional-credit-page
   ```

   `/title` takes 1, 2 or 3, or your own wording. `/photo` crops the photo to
   1600 × 900, replaces the temporary cover and marks the article ready. The
   workflow re-runs the site build and replies on the pull request.
4. **Merge.** Approve and merge. A draft merged without `/photo` stays
   unpublished.
5. **Publishing.** "Blog publishing" runs a few minutes after each category's
   slot and asks Amplify to rebuild when an article's time has just passed.
   Expect the article live within about 15 minutes of its slot.
6. **Reminders.** On weekday mornings, one email lists any draft that has
   waited more than two days.

If a run cannot verify a topic, it tries an evergreen topic in the same
category. If that also fails, the reviewer gets a "no draft this run" email
instead. Any run can be started by hand from the Actions tab. "Blog drafts"
defaults to a dry run that saves the draft as a download without opening a
pull request or sending email.

## Article template

```markdown
---
slug: hoa-board-member-personal-liability
title: "Can HOA Board Members Be Sued Personally? What D&O Covers"
description: "What a D&O policy pays for when volunteer directors are named in a claim, the common exclusions, and the limit questions boards should ask."
topic: D&O and Crime
tags: [d&o, board liability]
publishedAt: 2026-11-10T09:00:00-05:00
draft: true
image:
  src: /images/blog/hoa-board-member-personal-liability/cover.jpg
  alt: Board members reviewing documents at a conference table
  width: 1600
  height: 900
  credit: "Photo: HOA Insurance Agency"
  provenance: Agency photo taken for this article, all rights held.
sources:
  - title: Source page title
    publisher: Publisher name
    url: https://example.gov/exact-page
    accessedAt: 2026-11-03T10:00:00-05:00
---

> One-paragraph summary of what the reader will learn and why it matters now.

## First section heading

Paragraph one. Paragraph two. Paragraph three.

## Second section heading

...
```
