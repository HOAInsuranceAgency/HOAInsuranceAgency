# SPEC — Dialpad integration

Status: **design, awaiting approval**. Not started.
Target: `crm/` only. `web/` is untouched.
Written against `staging` @ `d0e9649`.

This document is the contract for a two-way Dialpad integration: every call,
text and voicemail between the agency and an association lands on that
account's record, and a producer can call or text from the CRM without
leaving it. Each workstream (W0–W6) is independently reviewable and lands as
its own commit on `staging`.

Read [Ground rules](#ground-rules) first. `docs/audit/PATTERNS.md` is binding.

---

## Contents

- [What this is](#what-this-is)
- [Ground rules](#ground-rules)
- [Decisions made (2026-08-25)](#decisions-made-2026-08-25)
- [The three hard problems](#the-three-hard-problems)
- [Schema](#schema)
- [Dialpad configuration](#dialpad-configuration)
- [W0 — Phone index](#w0--phone-index)
- [W1 — Ingestion](#w1--ingestion)
- [W2 — Timeline](#w2--timeline)
- [W3 — Triage queue](#w3--triage-queue)
- [W4 — Click-to-call](#w4--click-to-call)
- [W5 — Texting](#w5--texting)
- [W6 — Recordings and transcripts](#w6--recordings-and-transcripts)
- [W7 — Digest integration](#w7--digest-integration)
- [Compliance](#compliance)
- [Migration and rollout](#migration-and-rollout)
- [Verification](#verification)
- [Open questions](#open-questions)

---

## What this is

The CRM has no phone log. `ops-rollup/detect.ts:137` says so out loud, and
pays for it: `LEAD_UNTOUCHED_DAYS` is set to three business days rather than
something tighter *because* a producer working an account by phone is
invisible to the system, and a shorter threshold "flags exactly the producers
who are working the account by phone rather than typing into a screen."

That is the hole this fills. Commercial lines is a phone business — a first
conversation with a board president is a scheduled call — and today none of it
is recorded anywhere the agency can see. The renewal that was chased four
times by phone and the one nobody called look identical in the CRM.

Dialpad becomes the telephony system of record. This integration makes the CRM
the *account* system of record for what was said, to whom, and when — for
leads and clients alike, because both are `Account` rows and neither needs a
separate mechanism.

**Not in scope.** Replacing the existing web-lead text alerts
(`lead-intake/sms.ts`). Those are one-way SNS notifications *to producers* when
a web lead lands — a different thing from a conversation with a customer, and
they keep working unchanged. Nothing here touches SNS.

---

## Ground rules

These are not suggestions.

- **Schema enums are declared once**, in `crm/amplify/data/resource.ts`, and
  derived everywhere else with `as const satisfies Record<TheEnum, …>`. The
  four new enums below (`CommChannel`, `CommDirection`, `CommState`,
  `MatchConfidence`) are named exactly once. No label map, no `<option>` list,
  no runtime `Set`, no prose copy in a prompt. See PATTERNS.md § *Schema enums
  are derived, never re-typed*.
- **A client permission gate never ships alone.** Every `useIsAdmin()` check
  added here lands with the model rule that enforces it. See PATTERNS.md § *A
  client permission gate is never introduced alone*.
- **All schema changes are additive nullable fields and new models.** No
  column is removed or retyped, so every workstream is revertible by
  redeploying the previous commit. Precedent: `Account`'s deprecated contact
  columns.
- **`Communication` is Lambda-written and client-read.** Client authorization
  is read-only; every write happens in a Lambda over IAM; `occurredAt` and
  every timestamp are server-set. No UI path can edit or back-date a call
  record. This follows `Activity` and `LeadReply` exactly, and for the same
  reason: a communications log that staff can rewrite is not a log.
- **Backend code is type-checked before it deploys.** `npm run
  typecheck:backend` is not optional and `npx tsc --noEmit` does not stand in
  for it — the two tsconfigs disagree. Run both, plus `npx vitest run`, before
  any push touching `crm/amplify/`.
- **Nothing recorded ships enabled.** W6 is behind an `AgencySettings` flag
  that is absent-means-off, the same shape as `premiumFinanceEnabled`.

---

## Decisions made (2026-08-25)

1. **Scope: full two-way, including texting.** Ingestion, click-to-call, and
   an SMS thread the producer can read and reply to from the account page.
   Phased W0–W6 for delivery; nothing is descoped.
2. **Recordings: link + transcript stored.** The CRM keeps the transcript and
   the recap summary, and a *reference* to the audio — see
   [Recording access](#3-recording-access-a-stored-link-is-not-a-clickable-link)
   for why the audio itself is deliberately not copied.
3. **Unknown numbers go to a triage queue.** An inbound call from a number
   that matches nothing is logged unattached and worked by a human, who
   attaches it to an account or turns it into a lead. Nothing is auto-created.
   This matters beyond tidiness: `lead-intake/handler.ts:241` records that
   matching an incoming lead against existing leads "is a decision" the agency
   has not made. A caller-ID matcher that auto-creates would be making that
   decision silently, in the least reviewable place available. The queue keeps
   it a human call.
4. **Auth: one company-level API key**, in Secrets Manager, matching the
   `stripe-webhook` pattern. Producer attribution comes from mapping Dialpad
   user email → `UserProfile.email`.

**Decision 4 and decision 1 do not conflict**, which is worth stating because
it looks like they should. `POST /api/v2/sms` accepts a `user_id` naming the
sender, so one company key can send a text *as* a named producer — it arrives
from their Dialpad number and threads into their Dialpad history. Per-user
OAuth buys nothing here and costs token storage, refresh handling, and a
re-auth path for every lapsed grant. It stays unbuilt until something actually
needs it.

---

## The three hard problems

Everything else in this document is plumbing. These three are the design.

### 1. Identity resolution: a phone number is not a key

Nothing in this schema is indexed by phone. `Contact.phone` and the deprecated
`Account.contactPhone` are free-form strings — deliberately, because
`a.phone()` accepts only E.164 and rejects both `555-123-4567` and the
extensions people actually type. There are thirteen secondary indexes in
`data/resource.ts` and not one is on a phone number.

So a webhook Lambda holding `+15082332261` has no way to ask "whose is this?"
short of scanning `Contact`. At one scan per call event — and Dialpad sends
five to seven events per call — that is both slow and expensive, and it gets
worse every year the agency grows.

**The fix is a derived reverse index**, `PhoneLink`, maintained off the
DynamoDB streams that already feed `activity-log`. `Contact.phone` stays the
source of truth, free-form, exactly as typed. `PhoneLink` is a normalized
projection of it that can be thrown away and rebuilt.

Derived rather than authoritative for three reasons: staff keep typing numbers
however they type them; nothing is silently rewritten under the person who
typed it (the same rationale already written on `UserProfile.mobilePhone`);
and a wrong index is repairable by replay rather than by data entry.

**One number belongs to many accounts.** This is not an edge case in HOA
lines — it is the normal case. A property manager at a management company
handles thirty associations, and `Contact` is `belongsTo` exactly one
`Account`, so that manager is thirty `Contact` rows sharing one phone number.
A resolver that returns a single account will be wrong constantly and
confidently.

`PhoneLink` therefore holds **one row per (number, account) pair**, and
resolution returns a *list*:

| Candidates | `matchConfidence` | Behaviour |
|---|---|---|
| 0 | `UNMATCHED` | Filed under nobody. Lands in triage. |
| 1 | `EXACT` | Filed under the person; appears on their one account. |
| 2+ | `SHARED` | Filed under the person; appears on all of them. |

**A call is filed under the person, not under an association** (decided
2026-08-26). This is the decision the rest of the design hangs off, so it is
worth being explicit about what it rejects.

The tempting answer is to guess — pick the association that producer touched
most recently, mark the row uncertain, offer a one-click correction. It reads
well and it is wrong in a way that is hard to see: when the guess misses, an
association that was never serviced now shows a phone conversation on its
record, and the one that *was* serviced shows nothing. Both halves are wrong,
and W7 then feeds the wrong half into the digest, where a genuinely untouched
lead stops being flagged because a call about a different association was
filed against it. A silent wrong answer is worse than a visible unknown.

The opposite answer — never guess, queue every call from a shared number —
is honest but unworkable at the volume that actually occurs. A property
manager rings often, each call becomes a to-do, and a queue full of routine
calls stops being read. That costs the queue its actual job, which is
surfacing the callers nobody recognises.

So the CRM records what it knows and declines to invent what it does not. It
knows *who* called: Marcia Webb, property manager. It does not know which of
her thirty associations the call concerned, and neither would a person reading
a phone number. The call therefore appears on all thirty, labelled as a call
with Marcia Webb rather than as a call about any one of them.

The cost is real and stated here rather than discovered later: thirty
timelines show a call that may not concern them. That is acceptable because
the label does not claim otherwise — and it is exactly why **W7 must not count
a `SHARED` call as a touch** for the untouched-lead finding. Thirty accounts
would go quiet at once. See the open questions.

**Outbound calls started in the CRM skip all of this.** `initiate_call`
accepts `custom_data`, "passed through to any subscribed call events" — so the
CRM stamps the account id on the way out and reads it back on the way in.
Exact by construction, no matching involved. This is the strongest argument
for W4 and the reason it is not the last workstream.

### 2. Event shape: Dialpad describes a call many times

Stripe's webhook is mostly terminal — an event says a thing happened and the
handler writes it down. Dialpad's is a running commentary. One call produces
`ringing`, `connected`, `hangup`, then later `recording`, then
`call_transcription`, then `recap_summary`, each a separate POST carrying the
same `call_id`.

Two consequences the handler must be built around:

- **Every write is an upsert keyed on `dialpadCallId`**, never an insert. The
  row is created by whichever event arrives first and enriched by the rest.
- **Events can arrive out of order.** Each carries `event_timestamp`; the
  handler stores `lastEventAt` and writes conditionally on the incoming
  timestamp being newer, so a delayed `ringing` cannot overwrite `hangup` and
  resurrect a finished call as an in-progress one.

### 3. Recording access: a stored link is not a clickable link

Every Dialpad recording URL is under `https://dialpad.com/secureblob/callrecording/`
and requires OAuth or an API key carrying the `recordings` scope. Rendering
one as an `<a href>` produces a 401 and a user who thinks the feature is
broken.

So the CRM stores the reference and serves the audio through an authenticated
proxy — a mutation that checks the caller, fetches with the agency key, and
returns a short-lived URL.

**The audio is deliberately not copied into S3.** The transcript is; the audio
is not. That asymmetry is intentional:

- The transcript is text, small, searchable, and already a derived artifact.
  Copying it is what makes a call useful inside the CRM at all.
- The audio is the raw record and the highest-sensitivity object in the
  system. Leaving it in Dialpad means Dialpad's retention policy governs it,
  its admin access controls apply to it, and — the part that matters — a
  deletion in Dialpad is an actual deletion rather than a deletion of one of
  two copies.

Copying audio into S3 would create a second retention surface that nobody is
administering, under a statute (see [Compliance](#compliance)) where the
agency's exposure is criminal rather than contractual. If the agency later
wants an archival copy, that is a deliberate decision with a retention
lifecycle attached, not a side effect of building a timeline.

---

## Schema

All additive. Four enums, two models, three fields on existing models.

### Enums

```ts
CommChannel:     a.enum(["CALL", "SMS", "VOICEMAIL"]),
CommDirection:   a.enum(["INBOUND", "OUTBOUND"]),
// Terminal states only. Dialpad emits ~25 call states including monitoring
// and AI-processing ones; the CRM records what happened to the conversation,
// not every transition it passed through. `eavesdrop`, `barge`, `parked` and
// the recap_* states are consumed by the handler and never stored as state.
CommState:       a.enum(["CONNECTED", "MISSED", "VOICEMAIL", "ABANDONED"]),
MatchConfidence: a.enum(["EXACT", "SHARED", "UNMATCHED", "MANUAL"]),
```

### `PhoneLink` — the reverse index

```ts
PhoneLink: a
  .model({
    // E.164, normalized. The partition key of the lookup index.
    e164: a.string().required(),
    accountId: a.id().required(),
    // Null when the number came off the Account rather than a Contact.
    contactId: a.id(),
    // Denormalized so the triage queue and the ambiguous-match card can name
    // the candidate without a read per row. Same rationale as
    // Activity.actorName: a renamed contact does not rewrite history.
    accountName: a.string(),
    contactName: a.string(),
    source: a.ref("PhoneLinkSource").required(), // CONTACT | ACCOUNT | MANUAL
    // Robocallers and wrong numbers, marked from the triage queue. A
    // suppressed number is resolved but never queued again.
    suppressed: a.boolean(),
    linkedAt: a.datetime().required(),
  })
  .secondaryIndexes((index) => [index("e164"), index("accountId")])
  .authorization((allow) => [
    allow.authenticated().to(["read"]),
    allow.groups(["ADMIN"]),
  ]),
```

Read-only to the client and ADMIN-writable, because it is derived: a staff
edit would be silently reverted by the next stream event on the underlying
`Contact`, which is worse than not offering the edit. Numbers are corrected by
editing the contact.

### `Communication` — the log

```ts
Communication: a
  .model({
    // NO accountId. A call is filed under the person, and which accounts it
    // appears on is CommunicationAccount's business — see the decision under
    // Problem 01. This is also why it cannot fold into Activity, whose
    // entityId is required and singular.
    contactId: a.id(),
    contactName: a.string(),
    channel: a.ref("CommChannel").required(),
    direction: a.ref("CommDirection").required(),
    // Dialpad's ids. The idempotency key — the handler upserts on these, never
    // inserts, because one call arrives as five to seven separate events.
    dialpadCallId: a.string(),
    dialpadMessageId: a.string(),
    externalNumber: a.string().required(), // E.164, the customer side
    internalNumber: a.string(),            // E.164, the agency side
    // Who at the agency. Null for a main-line call nobody claimed.
    userId: a.string(),      // Cognito sub, resolved via UserProfile
    userName: a.string(),    // denormalized, per Activity.actorName
    dialpadUserId: a.string(),
    occurredAt: a.datetime().required(),
    // Out-of-order guard. A write lands only if it is newer than this.
    lastEventAt: a.datetime(),
    // ── Call ──
    state: a.ref("CommState"),
    durationSeconds: a.integer(),   // talk time
    totalDurationSeconds: a.integer(), // incl. ring
    wasRecorded: a.boolean(),
    recordingUrl: a.string(),  // dialpad secureblob — NOT browser-openable
    recordingId: a.string(),
    // S3 key under communications/. The transcript is copied; the audio is
    // not. See "Recording access" for why those differ.
    transcriptKey: a.string(),
    // Dialpad Ai. Short, so it lives on the row and the timeline reads
    // without a fetch.
    recapSummary: a.string(),
    recapActionItems: a.string().array(),
    // ── SMS ──
    body: a.string(),
    mms: a.boolean(),
    mediaUrl: a.string(),
    messageStatus: a.string(), // sent | delivered | failed | undelivered
    // ── Matching ──
    matchConfidence: a.ref("MatchConfidence").required(),
    // How many accounts this call appears on. Denormalized so a card can say
    // "Marcia Webb — 30 associations" without counting the join rows, which
    // is the label that stops a SHARED call reading as a call about the one
    // association whose timeline it is being read on.
    appearanceCount: a.integer(),
    // Set when a human files an UNMATCHED call from triage. Never inferred.
    matchedBy: a.string(),
    matchedAt: a.datetime(),
    // ── Reading ──
    readAt: a.datetime(), // inbound only; drives the unread badge
  })
  .secondaryIndexes((index) => [
    index("dialpadCallId"),                             // idempotency
    index("matchConfidence").sortKeys(["occurredAt"]),  // the triage queue
    // The SMS thread. Keyed on the number, so a conversation reads correctly
    // while still unmatched and survives the person being identified later.
    index("externalNumber").sortKeys(["occurredAt"]),
  ])
  .authorization((allow) => [
    allow.authenticated().to(["read"]),
    allow.groups(["ADMIN"]),
  ]),
```

Client-read, Lambda-written over IAM. Filing from triage and sending a text
are **custom mutations**, not model writes, so the model rule stays closed and
there is no gate-without-a-rule. Precedent: `LeadReply`, `UploadPortal`.

### `CommunicationAccount` — where a call shows up

```ts
CommunicationAccount: a
  .model({
    communicationId: a.id().required(),
    accountId: a.id().required(),
    // Copied from the parent so the timeline sorts and renders from one
    // query. A timeline that had to read the parent per row would be N reads
    // to draw one screen.
    occurredAt: a.datetime().required(),
  })
  .secondaryIndexes((index) => [
    index("accountId").sortKeys(["occurredAt"]),   // the timeline
    index("communicationId"),                      // rewrite on re-filing
  ])
```

One row per account a call appears on. A call with a property manager who
holds thirty associations writes thirty rows, which is a rounding error in
DynamoDB and buys two things worth having.

**The timeline stays one query.** The alternative — deriving appearances at
read time by walking `PhoneLink` — needs one query per number on the account
and, worse, makes history retroactive: the day Marcia changes her number,
every call she ever made vanishes from all thirty timelines. A service record
that rewrites itself is not a record. These rows are written once, at the time
of the call, and are never recomputed.

**Re-filing is cheap and total.** When a human files an `UNMATCHED` call from
triage, the appearances are written then. When a call is re-filed, the old
rows are deleted and new ones written — the `communicationId` index is what
makes that a single query rather than a scan.

### Additive fields on existing models

```ts
// UserProfile — attribution. Resolved once from the Dialpad user list by
// email match; stored so every event does not re-resolve it.
dialpadUserId: a.string(),

// Contact — carrier-level STOP is invisible to the CRM otherwise, and a
// producer who keeps texting an opted-out number learns nothing from the
// silence.
textOptOutAt: a.datetime(),

// AgencySettings — W6's kill switch. Absent means off; ships dark.
// Written only by a dedicated mutation, like premiumFinanceEnabled.
callRecordingEnabled: a.boolean(),
callRecordingEnabledAt: a.datetime(),
```

---

## Dialpad configuration

**API key scopes.** The company key needs all four; three of them are not
obvious and each produces a silent partial failure if missed:

| Scope | Without it |
|---|---|
| `recordings_export` | Call events arrive with no recording URL. |
| `message_content_export` | SMS events arrive with no `text`. |
| `recordings` | The audio proxy 401s. |
| `contacts` (write) | Caller-ID push in W0 fails. |

**Webhook.** `POST /api/v2/webhooks` with `hook_url` and `secret`. Supplying
the secret is what makes events arrive "encoded and signed in the JWT format
using the shared secret with the HS256 algorithm" — without it Dialpad posts
unsigned JSON to a public URL, which is not acceptable here. Rate limit 100/min.

**Subscriptions**, both company-targeted. The company-target limit is 10 per
subscription type, so one of each is well inside it:

- Call events — states `connected`, `hangup`, `missed`, `voicemail`,
  `recording`, `call_transcription`, `recap_summary`.
- SMS events — both directions, `status=True` so delivery results arrive.

**Rate limits that constrain the design**, not just the runtime:

| Endpoint | Limit | Consequence |
|---|---|---|
| `POST /api/v2/users/{id}/initiate_call` | **5/min per user** | Click-to-call is a human action; fine. Never use it for automation. |
| `POST /api/v2/sms` | 100/min (tier 0) | Fine for staff texting. Not a bulk channel. |
| `POST /api/v2/contacts` | 100/min | W0's initial push must be throttled and resumable. |
| `GET /api/v2/transcripts/{call_id}` | 1200/min | Comfortable. |

**A constraint worth knowing before promising click-to-call:** `initiate_call`
requires the user to have "at least one active autocallable device (web app,
desktop app, or CTI application)" — **mobile apps and physical deskphones are
unsupported**. A producer working from their cell phone cannot use the CRM's
call button. It rings their desktop or it does nothing. This does not break
the design (the *logging* works regardless of how a call is placed) but it
does mean the button must be hidden or disabled rather than failing at the
API, and the team should know before it is sold to them as universal.

---

## W0 — Phone index

Build `PhoneLink` and fill it. Nothing user-visible.

- New Lambda `dialpad-phone-index`, consuming the `Contact` and `Account`
  DynamoDB streams. On a write it normalizes the phone with the existing
  `toE164` (lifted from `lead-intake/sms.ts` to a shared module — it is already
  tested, and a second implementation is a second set of bugs), then upserts or
  removes the `PhoneLink` rows for that contact.
- **Stream consumer count.** `Contact` and `Account` already have
  `activity-log` on their streams. DynamoDB Streams allows two consumers per
  shard before reads start being throttled, so this lands exactly at the
  limit. A third consumer on either table is a design change, not an addition
  — note it here so the next person does not discover it in production.
- A backfill script under `crm/scripts/` walks every `Contact` and `Account`
  and writes the initial rows. Idempotent, resumable, re-runnable.
- **Push contacts to Dialpad** — `POST /api/v2/contacts` upsert, keyed on the
  CRM contact id as `uid` so re-running updates rather than duplicates. Phones
  in E.164, first in the list is primary. This is what makes a producer's
  phone show "Marcia Webb — Beacon Hill Condo Trust" before they answer, which
  is most of the practical value of the whole integration and arrives before
  any of the CRM UI does.
  - One Dialpad contact per *person*, not per (person, account) pair — a
    property manager is one entry, and the CRM's `PhoneLink` rows are what
    know about the thirty associations.

**Verification.** Unit tests for normalization and for the multi-account fan
out; a test that a contact's phone changing removes the old link and adds the
new one; a test that deleting a contact removes its links.

---

## W1 — Ingestion

The webhook. Nothing user-visible yet; the rows start accumulating.

`crm/amplify/functions/dialpad-webhook/`, a Lambda Function URL with
`FunctionUrlAuthType.NONE`, exactly like `stripe-webhook` and for exactly the
same reason: Dialpad cannot sign SigV4, so the signature check *is* the
authentication and it happens before anything else runs.

**Where this differs from the Stripe precedent, and it matters:** the request
body *is* a JWT, not JSON with a signature in a header. So:

```
1. read the raw body — a JWT string
2. jwt.verify(body, secret, { algorithms: ["HS256"] })   ← pin the algorithm
3. only now read the claims
```

`algorithms` is not optional and not a default. A JWT names its own algorithm
in a header the attacker controls; a verifier that trusts it accepts `alg:
none` and, with an HS256 secret, is open to RS256/HS256 confusion. This is a
sharper edge than the Stripe handler has — there the signature and the payload
arrive separately, here they arrive in one string and an unpinned verify is a
public write endpoint.

Handler shape — `decide.ts` pure, `persist.ts` doing the writing, matching
`stripe-webhook`'s split so the routing rules are testable without mocking
DynamoDB:

- Verify, then map the event to a `Communication` shape.
- Resolve identity: `custom_data` if present (outbound from the CRM — exact),
  else `PhoneLink` lookup on the external number.
- Resolve the producer: `target` → Dialpad user id → `UserProfile`.
- Upsert on `dialpadCallId` / `dialpadMessageId`, conditional on
  `lastEventAt`.
- Ignore states that are not stored (`eavesdrop`, `parked`, `barge`, …) rather
  than mapping them to something.

**Verification.** Fixture payloads for each subscribed state. Tests for:
out-of-order arrival leaving the newer state intact; the same event delivered
twice producing one row; an unknown number producing `UNMATCHED` with no
appearance; a two-account number producing `SHARED` and two appearances;
`custom_data` overriding a would-be ambiguous match; a tampered JWT rejected;
an `alg: none` JWT rejected.

---

## W2 — Timeline

A **Communications tab** on `AccountDetail`, beside Activity.

Not merged into the Activity tab. `Activity` is a field-diff log — `changes:
json`, written by a stream handler, answering "what changed on this record."
A call is not a diff, has no subject row, and needs a player, a transcript
disclosure and a reassign control. Two models, two tabs, one mental model
each.

- `tabsFor()` gains `["communications", "Communications"]` for both stages —
  leads and clients alike, no `LEAD_ONLY_TABS` / `CLIENT_ONLY_TABS` entry.
- One `useAsyncResource` over
  `listCommunicationByAccountIdAndOccurredAt`, per PATTERNS.md § *One async
  read, one `useAsyncResource`*.
- Cards render channel, direction, who, when, duration, and the recap summary
  when there is one. A `SHARED` card names the person and says how many
  associations they manage, so nobody reads it as a call about this one.
- Unread inbound texts drive a count badge on the tab.

---

## W3 — Triage queue

A page at `/communications/unmatched`, and a dashboard tile.

Queries `matchConfidence = UNMATCHED`, newest first. Per row: the number, when,
how long, which agency line, and any name Dialpad's own caller ID supplied.

Four actions, all custom mutations:

- **Attach to account** — search, pick, done. Writes `matchedBy`/`matchedAt`
  and, optionally, a `PhoneLink` row so the next call from that number
  resolves itself.
- **Create lead** — spins a `LEAD` account with the number on a primary
  contact, then attaches. This is the human-in-the-loop dedup decision that
  `lead-intake` declined to automate; it stays a person's call, made with the
  account list in front of them.
- **Not a customer** — writes a suppressed `PhoneLink`. Same number never
  queues again.
- **Ignore** — leaves the row, clears it from the queue.

---

## W4 — Click-to-call

A call button on the account header and on each contact.

`POST /api/v2/users/{id}/initiate_call` with the producer's `dialpadUserId`,
the contact's E.164 number, and **`custom_data` carrying the account id and
contact id**. Dialpad rings the producer's desktop, then dials out; the call
events come back stamped with the ids, and the match is exact rather than
inferred.

- Hidden when the signed-in user has no `dialpadUserId`.
- 5/min per user is a human ceiling, but surface the 429 rather than swallowing
  it.
- Mobile-only producers cannot use this — see
  [Dialpad configuration](#dialpad-configuration). The button explains itself
  rather than erroring.

---

## W5 — Texting

An SMS thread on the Communications tab, and a compose box.

- **Thread reads by number**, not by account:
  `listCommunicationByExternalNumberAndOccurredAt`. A conversation that began
  before the number was matched reads correctly the moment it is attached, and
  survives a reassignment.
- **Send** — a `sendText` mutation → Lambda → `POST /api/v2/sms` with
  `user_id` (the signed-in producer's), `to_numbers`, `text`. The reply comes
  from their Dialpad number and threads into their Dialpad history.
- **No double-write.** The send writes a row optimistically and stores the
  message id from the API response; the outbound SMS webhook then upserts onto
  the same id. If the webhook wins the race, the upsert reconciles.
- **`textOptOutAt`** — Dialpad and the carriers handle STOP; the CRM records
  it so the compose box can refuse and say why, instead of a producer texting
  into a void for a fortnight.
- **10DLC.** Application-to-person business texting on a US number requires
  brand and campaign registration, done through Dialpad. Unregistered traffic
  is filtered by the carriers, silently and inconsistently, which presents as
  "some texts don't arrive." Registration is a prerequisite for this
  workstream, not a follow-up — see [Open questions](#open-questions).

---

## W6 — Recordings and transcripts

Behind `AgencySettings.callRecordingEnabled`, absent-means-off, flipped only
by a dedicated ADMIN mutation. Ships dark. **Do not start this workstream
before the compliance question below is answered.**

- On the `recording` event: store `recordingUrl` and `recordingId`. Do not
  fetch the audio.
- On `call_transcription`: `GET /api/v2/transcripts/{call_id}`, write the
  `lines[]` to S3 under `communications/{id}/transcript.json`, store the key.
  S3 rather than the row because a 40-minute call's transcript is a hundred
  kilobytes of speaker-tagged JSON, and DynamoDB reads whole items — inlining
  it would make every timeline query pay for it.
- On `recap_summary`: store `recapSummary` and `recapActionItems` on the row.
  These are short and they are what makes the timeline readable at a glance.
- **Audio playback** goes through a `getCallRecording(communicationId)`
  mutation: authorize the caller, fetch from Dialpad with the agency key,
  return a short-lived URL. Never render `recordingUrl` as an href.

---

## W7 — Digest integration

Deliberately last, and deliberately its own workstream: `ops-rollup` shipped on
2026-08-24 and its thresholds are tested. This changes their meaning, so it
changes them on purpose rather than as a side effect.

With a phone log, a call counts as a touch, and:

- `LEAD_UNTOUCHED_DAYS = 3` can tighten. Its comment says explicitly that
  three exists because phone work is invisible. Once it is visible, the number
  should be re-argued from what good service actually looks like.
- New findings become possible: an inbound call from a client that was missed
  and never returned; a lead called once and then dropped; a quote sitting
  with a board that nobody has phoned about.
- `done.ts`'s "accounts touched" gets honest.

---

## Compliance

Not legal advice. These are design constraints to put in front of counsel —
and this repo already has the habit, with a `PfCounselOpinion` model and a
signed-off jurisdiction table.

**Recording consent.** The agency writes in Massachusetts and Rhode Island,
and they differ. Massachusetts (G.L. c. 272 § 99) is an all-party regime and
its wiretap statute is criminal, turning on *secret* recording. Rhode Island
(§ 11-35-21) is one-party. The binding constraint is therefore Massachusetts,
and it applies to inbound calls from board members who never agreed to
anything.

Design consequences:

- **Consent is Dialpad's job, not the CRM's.** Dialpad has a recording
  announcement at office level. Turn it on there. The CRM must not reimplement
  consent capture, and must never be the thing that makes an unannounced
  recording convenient to use.
- W6 ships behind a flag so the capability can be switched off in minutes
  without a deploy, the same shape as the premium-finance kill switch and for
  the same reason.
- Whether transcripts of an unannounced call should exist at all is a question
  for counsel, and it is upstream of W6 rather than inside it.

**Texting.** 10DLC registration as above. TCPA governs the content: consent to
be contacted, and honouring opt-out. `textOptOutAt` is the mechanism; the
policy is the agency's.

**Data.** Transcripts are verbatim customer speech in the agency's own store,
and become discoverable, retainable, and breach-relevant. That is a real cost
of decision 2 and it is worth re-confirming with the retention period written
down.

---

## Migration and rollout

Every workstream is revertible by redeploying the prior commit — all schema
changes are additive nullable fields and new models, and a removed field does
not delete its DynamoDB attribute.

Order matters twice: W0 before W1 (no index, no matching), and the Dialpad
webhook subscription is created **last** in W1's deploy, so the endpoint exists
before events are pointed at it.

The rollback point for W0 is the backfill: it writes only `PhoneLink` rows and
Dialpad contacts, and touches nothing existing.

Staging first, on the staging Dialpad office if the plan supports a second
office — see [Open questions](#open-questions). Amplify app `d2d4g940z91vj4`,
branch `staging`, `us-east-1`.

---

## Verification

Per workstream, before any push touching `crm/amplify/`:

```bash
cd crm && npm run typecheck:backend && npx tsc --noEmit && npx vitest run
```

All three. The root tsc does not prove the backend compiles — the two
tsconfigs disagree on `noUncheckedIndexedAccess`, which has already cost one
failed staging deploy.

Beyond the per-workstream tests above:

- A source-assertion test that no enum member list is written twice.
- An end-to-end staging test placing a real call and asserting the row.
- A test that the webhook rejects an unsigned and a wrongly-signed payload.

---

## Open questions

1. **Does the Dialpad plan include a second office for staging?** If not,
   staging and production share a telephony tenant and the staging webhook
   will receive real customer calls. That is a data-handling problem, not an
   inconvenience, and it changes W1 — the fallback is a replay harness driven
   by recorded fixtures and no staging subscription at all.
2. **Is 10DLC registration done?** It gates W5 and it is not a same-day
   process.
3. **Who may read a transcript?** The schema above grants every authenticated
   user read on `Communication`. That is consistent with the rest of this CRM
   (no model carries an owning-producer id, so there is nothing to scope on),
   but a call recording is a different kind of object from a quote and this is
   the moment to say so if it should be ADMIN-only.
4. **Retention.** How long do transcripts live? Nothing in the CRM expires
   today; this is the first data with a reason to.
5. **Which calls count as a touch for the untouched-lead finding?** Two
   separate questions now, and the first has a clear answer.
   - A `SHARED` call must **not** count. Filing under the person means one
     call with a manager appears on thirty timelines; counting it would mark
     thirty associations serviced on the strength of one conversation and
     silence the finding across all of them. Only `EXACT` calls are touches.
   - Whether an unanswered outbound counts is still open. Arguably
     `state = CONNECTED` is the bar and an attempt is not a touch.
