# Slopbot worker

Hosted Slopbot GitHub App service under `protocol/slopbot-v2.md` (approved
9 October 2026; PRD BOT-08 to BOT-13). It is not deployed yet, and closing is
disabled by `SLOPBOT_CLOSURE_ENABLED = "false"`.

## Flow

1. `POST /github/webhook` verifies `X-Hub-Signature-256`, records the delivery
   ID once, updates installation state, and enqueues identifiers only.
2. The queue consumer gets an installation token and re-reads the
   repository, the item, `.github/slopbot.json`, and `AGENTS.md`,
   `CONTRIBUTING.md` and `README.md` from the default branch at its current
   SHA.
3. `routing.ts` applies the published precedence: installation, private
   repository, type switch, open/draft, bot author, human reopen, exemption,
   audience, author cap, budget.
4. Deterministic pre-filters (empty, same-author duplicate) run without a model.
5. `models.ts` runs triage: Surplus `claude-opus-5.5`, then Surplus
   `gpt-6.1-sol` as fallback (owner decision, 9 October 2026). Every call is written to
   `slopbot_costs` with cost and billed amount (cost + 10%).
6. A close needs all of the following:
   - the category set to `close`;
   - verified evidence;
   - for guidance categories, a rule quoted verbatim from the named file;
   - confidence ≥ 0.9;
   - closure enabled globally and by the repository;
   - the shadow period over;
   - no circuit breaker and no daily cap hit;
   - a confirming second verdict (Surplus, falling back to GPT-6.1 Sol);
   - an unchanged item just before acting.

   Otherwise the bot only comments and labels.
7. `/slopbot appeal` from the author, or any reopen, blocks re-closing that
   revision.

## Repository policy file

`.github/slopbot.json` on the default branch:

```json
{
  "version": 1,
  "audience": "protection",
  "issues": true,
  "pullRequests": true,
  "closure": false,
  "categories": { "out_of_scope": "label", "spam": "close" }
}
```

A missing or invalid file means label-only review.

## Budget-block recovery

A structured provider budget rejection writes an immutable block in
`slopbot_budget_blocks`. The same database operation ends the claimed attempt
with the explicit reason `blocked: provider budget exhausted`. The queue
acknowledges that durable state, so a monthly reset does not exhaust its short
failure-retry allowance. Early redeliveries do not call a model.

The five-minute scheduled handler sends due jobs for active installations,
then records each dispatch. A failed or uncertain queue send leaves recoverable
work. Duplicate sends remain subject to the existing revision check and review
lease. Recovery re-reads GitHub and policy before it can infer or act; it is
unbilled under the service-retry rule. The public summary reports
`itemsBlocked` separately from completed reviews.

Apply migration `0024_slopbot_budget_blocks.sql` before the worker and summary
API. This recovery mechanism does not set provider limits, reserve prepaid
credit, or make an estimated token price a hard spending cap.

## Cost statements and vault billing

On the Surplus Anthropic endpoint, a structured spending-limit rejection stops
the model route. It does not trigger the Sol fallback. Other provider failures
keep the configured fallback behavior. The failed call retains the safe reason
`provider budget exhausted`; no provider message body is stored. This is
rejection handling, not proof that a spending limit has been configured.
The [provider guide](https://www.surplusintelligence.ai/llms.txt) documents the
Anthropic error envelope and the separate management permission for budgets.


`GET /api/v1/payments/slopbot/installations/<id>/invoices/<YYYY-MM>` returns
one installation's billed model calls for the UTC month. Values use integer
micro-USDC. This is a cost statement, not a request for payment or proof of
settlement. The fee offset is zero until a reviewed project binding exists.

New cost rows use the `review-v2` billing rule. Each append calculates the
difference between the whole review's rounded cost-plus-10% total and the
amount already recorded for that review. Triage and confirmation therefore
share one rounding boundary. Failed calls and service retries add no billable
cost. Token-rate arithmetic uses integers throughout.

Migration `0023_slopbot_review_billing.sql` preserves old `call-v1` amounts.
A previously billed legacy review cannot accept a new billable call under
the new rule without explicit reconciliation. A call already made is retained
as unbilled evidence before the review reports this failure. Unbilled retries
can still be recorded. These rows remain cost statements: estimated rates do not prove
provider settlement, and this calculation does not reserve a budget or
authorize a service charge.

Billing must use the existing project vaults under PAY-10. The owner authorizes
`chargeService` on Base or `charge_service` on Solana. The operation must use
only free sponsor funds, preserve reserved awards and donor funds, and prevent
a second charge for the same invoice digest. Neither contract has that
operation yet; finalized invoice reconciliation is also required before launch.
Issue #616 tracks these dependencies.

Do not send service deposits to payout-fee wallets. There is no public prepaid
deposit-credit endpoint. A past fee transfer must never become new service
credit. This change neither enables billing nor moves funds.

## Setup checklist (owner)

Do these in order. Each step names who does it and how to verify it.

1. **Use the registered App** (an org owner of SlopDotCash):
   [slopdotcash](https://github.com/apps/slopdotcash), App ID `5257625`.
   Do not create a second App or use the unrelated `slopcash` App.
   - Homepage: `https://slop.cash`.
   - Webhook: active. URL: `https://<worker host>/github/webhook`. Set this
     after step 6; until then, leave the webhook inactive.
   - Webhook secret: generate with `openssl rand -hex 32` and keep it for
     step 4.
   - Permissions: Contents read, Metadata read, Organization members read,
     Issues write, Pull requests write. No others.
   - Events: Installation, Issues, Issue comment, Pull request.
   - "Where can this App be installed": Any account.
   - Verify: the App page shows exactly these permissions.
2. **Get the App identity:**
   - Record the App ID shown on the App page.
   - Get the bot user ID from `https://api.github.com/users/slopdotcash%5Bbot%5D`
     (the `id` field).
3. **Create the key:** on the App page, click "Generate a private key". Then
   convert it:
   `openssl pkcs8 -topk8 -nocrypt -in slopbot.private-key.pem -out slopbot.pkcs8.pem`.
   Delete both files after step 4.
4. **Add the Cloudflare secrets** (account owner), using
   `bunx wrangler secret put <NAME> --config workers/slopbot/wrangler.toml`
   for each of:
   - `SLOPBOT_WEBHOOK_SECRET`
   - `SLOPBOT_APP_ID`
   - `SLOPBOT_APP_USER_ID`
   - `SLOPBOT_APP_PRIVATE_KEY` (the PKCS#8 PEM)
   - `SURPLUS_API_KEY`

   Both models use the same Surplus key. The default Anthropic-compatible
   base URL is `https://api.surplusintelligence.ai/anthropic`. Optionally set
   `SURPLUS_BASE_URL` for another verified Surplus Anthropic endpoint.
5. **Create the queues in the production Cloudflare account** (the account
   in the `CLOUDFLARE_ACCOUNT_ID` environment secret, which also holds
   `slop-private` and the `eliza-computer` Pages project):
   `bunx wrangler queues create slopbot-jobs` and
   `bunx wrangler queues create slopbot-jobs-dlq`. A personal Cloudflare
   login is a different account; check with `bunx wrangler whoami` and
   `bunx wrangler d1 list` (it must list `slop-private`) first.
6. **One-time bootstrap (owner, after claiming the deploy lever):**
   1. In Cloudflare → Workers, create a Worker named `slop-slopbot` from the
      "Hello World" template. Do not deploy from a local tree.
   2. Add the custom domain `slopbot.slop.cash` to that Worker.
   3. Add the step 4 secrets.
   4. Attach the queue consumer:
      `bunx wrangler queues consumer add slopbot-jobs slop-slopbot --batch-size 5 --message-retries 5 --dead-letter-queue slopbot-jobs-dlq`.
   5. In GitHub → repository Settings → Variables, set `SLOPBOT_RELEASE` to
      `enabled`.

   The next protected release runs these steps:
   - checks the secret inventory;
   - uploads and promotes the version bound to the release SHA;
   - probes `https://slopbot.slop.cash/health`.

   Then set the App webhook URL to `https://slopbot.slop.cash/github/webhook`
   and activate it.
7. **Verify live:**
   - `GET /health` returns `{"service":"slopbot","ok":true}`.
   - The App's "Advanced" tab shows `202` for the ping delivery.
8. **Qualify billing for the dogfood installation:** install the App on
   `SlopDotCash/slopdotcash` only. There is no free allowance. Keep billable
   review disabled until the vault service-charge path and invoice
   reconciliation are qualified.
9. **Observe the shadow period:** review the labels and comments for at least
   14 days and 50 items, with `SLOPBOT_CLOSURE_ENABLED` still `"false"`.
   Enabling closure later is a separate reviewed PR that sets the variable
   and records the agreement data.

## App permissions and events

- **Read:** Contents, Metadata, Organization members.
- **Write:** Issues, Pull requests.
- **Events:** `installation`, `issues`, `issue_comment`, `pull_request`.

## Not yet implemented

- There is no free allowance. Review stays blocked until billing is qualified.
- Vault service charging and finalized invoice reconciliation (PAY-10/BOT-11).
- Reviewed installation-to-project binding and payout-fee offsets.
- SCR-01 penalty journal events. Closures record `penaltyEligible` for them.
- Maintainer dashboard and Automation row (LDR-04).

## Value assessment work in progress

The owner approved automatic **provisional** value scores under PRD SCR-06.
Payout approval stays human. See
[`slop-value-scoring-plan.md`](../../docs/slop-value-scoring-plan.md) for the
separate delivery checklist. This does not activate the closure switch.

`value-evidence.ts` collects paginated submitted changes, reported merge changes,
commit identities and discussion evidence. It reports missing patches, source
drift, API file limits and merge ancestry that needs joint review. A matching
squash diff can establish the accepted range; the final commit of a rebase or a
branch-sync diff cannot establish that range on its own. A read-only local
collection uses:

```bash
bun scripts/collect-value-evidence.ts OWNER/REPOSITORY PR_NUMBER /private/output
```

Raw evidence stays outside the repository. `value-review.ts` shares the strict
value rubric with the hosted model route. It does not publish scores or approve
awards. Source-bound publication, ingestion and complete historical calibration
must pass before this route can be activated. The September/October review uses
the owner's existing ChatGPT subscription; it does not authorize paid API calls.
A hosted service still requires its own supported runtime credentials.

Local evidence checks used real GitHub sources: Eliza #34772 has matching full
submitted and squash diffs; Delta Star #218 correctly requires ancestry review;
Delta Star #215 reports an omitted original-file patch instead of claiming full
coverage. These checks do not prove model execution or score publication.

Installation was verified on 10 October 2026: the owner installed the registered
App on elizaOS (installation `169856061`) with all repositories selected. This
proves App access, not worker deployment, model connectivity or score delivery.

## Runtime verification (10 October 2026)

The owner-supplied Surplus key passed live structured calls for
`claude-opus-5.5` and `gpt-6.1-sol` through the Anthropic endpoint above.
An unavailable primary model also exercised the live Sol fallback. These
checks used the same `runStructuredRoute` function as the worker. The endpoint
reports the served model; that report is not independent model attestation.

The marketplace response did not follow the requested schema when it was
provided only in `output_config`. The route now includes the exact schema in
the trusted prompt and still rejects every response that fails local validation.
Provider error bodies are not persisted. A model identity mismatch also fails.

A fresh read of Eliza #34772 resolved co-authors through GitHub's pinned commit
mapping, collected complete diff and discussion evidence, and produced a valid
Opus value assessment covering all three formal reviews. Email addresses used
to join co-author identities are omitted from the evidence export. This was a
local, read-only runtime test. A first schema-valid result double-credited the
same review finding. The rubric now requires explicit `duplicateOf` references
to earlier review identities; a duplicate cannot receive positive credit. A
subsequent live result identified the repeated finding correctly. Validation of
superseded heads still needs evidence of distinct retained value. Schema validity
alone is not semantic calibration. The test did not publish a score, run the hosted queue,
activate billing, or approve a payout. Hosted delivery and historical calibration
remain on the value-scoring acceptance checklist.


## Provisional assessment journal

`value-journal.ts` prepares source-bound records for the append-only D1 table
in migration `0014`. It revalidates the assessment against its exact evidence,
policy digest and configured served-model identity. The record contains the
safe rationale and source links, not patches, raw responses or prompts.

An exact source/rubric/producer retry returns the first canonical record.
A successor must name its predecessor and explain the change. The database
rejects competing successors, predecessors from another PR, edits and deletes.
The exact stored JSON bytes define the record digest. Consumers must retain
those bytes when they verify a record.

A local integration check applied the checked-in migration to real SQLite and
used the two real Eliza runtime assessments. It verified replay, digest/key
integrity, successor readback, retained history, and rejection of cross-PR
predecessors and competing successors. This is storage evidence only. No
production migration was applied. `value-publication.ts` checks the active
installation, its token-scoped repository membership, the exact repository IDs,
and freshly collected complete source and pinned policy. The insert also checks
installation state to reject a suspension/removal that arrives during the read.
The live source recheck matched Eliza #34772. Hosted App authentication remains
untested while credentials are pending.

The read-only `GET /v1/value-assessments?repository=OWNER/REPO&pull=NUMBER`
route returns ordered record strings and their digests. It accepts an `after`
sequence cursor, returns up to 100 records, and supplies `nextAfter` when another
page exists. Invalid queries return 400. A storage failure returns 503, never a
successful empty history. This route shows recorded history; it does not assert
that a record still matches GitHub or overrides a human decision.

A local Cloudflare Worker with local D1 passed HTTP readback using the checked-in
migrations and seeded real Eliza assessments. All returned record digests matched
the exact bytes; cursor reads, valid empty history and invalid-query responses
also passed. This does not prove hosted authentication, queue delivery or a
production write.

Queue scheduling, inference budget accounting, score/Points ingestion and human
precedence remain required before activation. No hosted queue has published a
record. Only the internal publisher may establish authority for a write; the
public reader cannot submit or alter assessments.


## Current value decisions

`readValueDecision` reads the complete journal for one registered source. It
checks exact byte digests, sequence order, immutable repository and pull-request
identity, and the predecessor chain before selecting the latest record. It
compares that record with the supplied complete source and pinned policy, then
validates the assessment and model identity. Its states are `missing`,
`incomplete`, `stale`, `unresolved`, and `assessed`. The first four do not supply
a numeric score. A caller must apply valid human ratifications before using a
provisional assessment. The database connection is the authority boundary;
matching a digest from an arbitrary host does not establish authority.

Publication uses this reader and requires a new result to name the current
predecessor. An exact assessment-key replay retains the original record. SQLite
still rejects concurrent forks after the read. Local integration checked real
Eliza evidence, 104 paginated revisions, changed source, incomplete evidence,
missing records, unresolved value and corrupted bytes. The leaderboard and
Points ingestion still require hosted activation; these checks do not change public
scores or prove a hosted publication.

## Provider request receipts

The Anthropic SDK response headers carry Surplus transport evidence. The route
retains `x-si-buyer-cost-micro` as a nullable integer in a separate immutable
`provider_cost_micro_usd` column (migration `0015`). Missing, fractional or
unsafe values remain unknown. This is a provider report, not a finalized invoice;
it does not replace the versioned price, change billing, or mark reconciliation
complete. Migration `0019` also retains the transport `x-request-id` in the
private immutable `provider_request_id` column. The model response body's ID
is a different identity. Only bounded ASCII identifiers are accepted; missing
or invalid IDs stay null, including all earlier rows. Neither header is exposed
by the public assessment reader.

`x-si-truncated: 1` rejects the response even if its JSON and stop reason appear
complete. SDK retries are disabled so each explicit route attempt has one cost
record. Failure responses retain a valid cost header without recording provider
error bodies. See the official [Surplus routing controls](https://www.surplusintelligence.ai/docs/marketplace/routing-controls).

Live Opus and Sol receipt checks passed on 10 October 2026. Controlled local HTTP
checks covered deadline truncation, fractional costs, error receipts and retry
count; the real SQLite migrations preserved the receipt and rejected its update.
Those local checks did not charge a contributor or reconcile a production invoice.

A live Sol call on 10 October 2026 confirmed that the transport ID retrieves
the exact Surplus request receipt. The model and cost matched; settlement was
still accrued. Local HTTP and SQLite checks retained IDs on success, truncation
and HTTP errors, ignored invalid IDs, and rejected changes to persisted IDs.
This provides a link for later reconciliation, not finalized invoice evidence.


## Webhook redelivery after queue failure

Receipt storage and successful dispatch are separate. Migration `0016` adds a
completion timestamp. A queue or receipt-write failure returns 503 and leaves
the delivery retryable. A later redelivery of the same signed event can enqueue
it; only a completed receipt returns the duplicate acknowledgement. Concurrent
or ambiguous sends can still deliver a job more than once, so consumer
idempotency remains required.

This does not make GitHub redeliver failed events automatically. Use GitHub's
redelivery control for a failed delivery. Existing receipts have no reliable
queue-acceptance evidence, so they remain retryable after migration.

A local fault-injection check used the actual worker fetch handler, HMAC-signed
requests and the real SQLite migrations. An injected first-send failure returned
503; redelivery accepted one job; the completed duplicate made no extra send.
Invalid JSON returned 400, and an invalid signature returned 401, without
creating receipts. This check did not exercise the hosted Cloudflare queue or
GitHub App credentials.

## Immutable billing evidence

Migration `0017` rejects changes to every cost field, credit deletion and SQLite
replacement of an existing cost or credit. This preserves installation and
model attribution as well as amounts. A credit reference cannot be reused to
replace a deposit. Corrections and invoice reconciliation require appended
evidence; this migration does not implement invoice reconciliation.

A local check exercised the model transport and `recordCalls` against the real
SQLite migrations. All 20 cost columns rejected updates; cost and credit
deletion and replacement failed; new cost and credit rows still appended, and
the derived credit balance retained both entries. No production funds changed.

Migration `0018` also prevents SQLite replacement through any of the value
journal's unique keys: sequence, digest, assessment key, PR root, or predecessor.
A local upgrade check applied it to an existing journal containing a real Eliza
assessment. Replays retained the original row, successors appended, and all five
replacement paths failed without changing historical bytes. The actual worker
reader returned the original JSON bytes. This is local storage evidence, not
production score publication.

Closed, unmerged assessments retain the GitHub closure date as `occurredAt`;
merged outcomes retain their merge date. Publication refuses an open outcome
or a missing occurrence date. The source digest includes the closure date, and
collection checks state and closure date again before returning evidence.
An existing assessment must be recollected and reassessed if this changes its
source digest; do not rewrite earlier assessment bytes.

The live collector retained the 15 September closure date for Eliza PR #31343
with no source limitations. Existing real merged-assessment journal checks also
passed. This check made no model call or public assessment and does not establish
the value of that closed PR's reviews.

## Recovery after an eligibility skip

A skip occurs before inference. A later event for the same revision rechecks
eligibility, including budget, draft state and author limits. If eligible, an
atomic claim permits the first actual review; completed and running reviews
remain deduplicated. Failed attempts remain unbilled Slop-caused retries.
The daily author cap counts completion time over the preceding 24 UTC hours,
including reviews that were first skipped on an earlier day.

A local routing/persistence check using the real SQLite schema covered an empty
balance followed by a deposit, competing claims, failed-attempt retry, completed
deduplication and the rolling completion-time cap. It made no provider call or
production write. Hosted queue recovery and atomic inference-budget reservation
still require separate qualification.

When every triage model route fails, the consumer persists a failed review and
throws to the queue handler. The handler requests a retry after 60 seconds;
the configured queue allows five retries before its dead-letter queue. A normal
return would incorrectly acknowledge the failed job. A successful retry remains
unbilled and completed revisions remain deduplicated.

A local end-to-end check used the actual queue handler, review service, SDK HTTP
transport and SQLite, with local GitHub and provider fixtures. Two failed routes
caused a retry; the next attempt completed; a duplicate made no further provider
request. All three call rows were retained with zero billed amount. This does
not prove hosted dead-letter delivery or production GitHub access.

Before posting any review action, the worker rereads repository visibility,
item state and content, revision, current policy/configuration and installation
state. A changed source, disabled configuration, missing/removed/suspended
installation, or closed/draft item discards the pending action. The failed
record preserves the reason and permits a later unbilled retry. This guard
applies to comments and labels as well as closure; it is not a transaction with
GitHub, so a change after the final read can still race an API write.

The local queue/service/SDK/SQLite workflow check changed state during the model
response. Unchanged advisory review made its two expected writes. Installation
removal, suspension, missing installation, private visibility, disabled review
configuration and edited source each made zero writes. GitHub and provider
responses were local fixtures; hosted permission and webhook checks remain open.

Comment creation requires GitHub's 201 response and a valid comment ID. Updates
require a 200 response for the stored ID; only a 404 permits creating a
replacement comment. Label writes require a 200 response containing the requested
label. An unconfirmed write fails the run and requests a queue retry instead of
recording successful action evidence.

The local queue workflow covered comment 404, invalid creation ID, redirected
update, label 404 and a response missing the requested label. Each failed and
retried; no unconfirmed action entered the ledger. Confirmed comments remained
recorded when the subsequent label failed. Normal comment/label success passed.

The initial review comment never announces a close. Only after GitHub confirms
the closed state does the worker record the close and update that comment with
the result. If the comment update fails, the confirmed close stays in the action
ledger and the run fails visibly. A rejected or failed close creates no close
record and no closure claim.

The isolated queue workflow exercised confirmed closure, an unchanged open
response, a close-request failure and a post-close comment-update failure. The
event sequence contained no closure claim before confirmation. Closure was
enabled only in that local fixture; production closure remains disabled.

After inference, closure eligibility is checked again against current author
permissions, recorded human-reopen signals and closure limits. Assignment,
exempt or unknown membership, and a human reopen at the reviewed revision prevent
closure. Local queue workflow checks changed each condition during inference:
all four made zero close requests, while the unchanged eligible case closed only
after confirmation. These checks do not enable production closure or establish
hosted membership permissions.


## Value score projection

The leaderboard generator accepts verified `valueDecisions` and GitHub-resolved
`valueActors`. When supplied, valid human ratifications take precedence across
the hydrated source set. Missing, incomplete, stale and unresolved decisions
receive no default implementation or review award. The snapshot retains a
coverage row for every accepted source. Assessed zeroes retain their ledger
source and actor, while integer-third shares preserve the assessed total.

Positive assessments require exact-head source agreement, hydrated human and
review decisions, complete implementation identities, and no overlapping
accepted commits that need joint assessment. Distinct positive review outcomes
use their assessed tier; duplicate and zero-valued reviews do not multiply
credit. Existing reviewed evaluator awards keep their precedence.

A local integration passed collected Eliza #34772 through the journal reader
and real snapshot generator and validator: nine implementation thirds, one
review award, no missing-value fallback, retained zero, wrong-head rejection,
and precedence for a controlled valid human-ratification fixture. The generator
entry point accepts these inputs. Hosted-feed operation, Points revision
ingestion, and public activation remain unverified. Legacy
inputs and frozen cycle files retain their existing behavior.


## Ingest published assessments

`bun scripts/generate-leaderboard.ts --value-assessments` enables the fixed
`https://slopbot.slop.cash/v1/value-assessments` feed. It can be combined with
`--cutoff`. The flag is not enabled in release workflows until the hosted
publisher and its production records are verified.

The generator rejects redirects, unavailable or invalid pages and changed
source. An unlinked commit author remains null in the source and adds no credit
recipient under SCR-04. The PR author qualifies through their verified PR
identity; the collector does not assign an unknown commit identity to them. An
empty successful history is explicitly missing, never a fabricated assessment. It checks current repository visibility
and identity, complete GitHub evidence, pinned policy and all journal revisions.
Each non-merge commit also retains its verified primary-author ID, complete
changed paths (including rename sources), and attribution limitations. Commit-file
pagination, repeated paths, the API cap, and addition/deletion totals are checked.
Incomplete path evidence is null and blocks assessment; it is never an empty
change set. The final PR stability read follows these commit and identity reads.
The whole-PR contributor set follows SCR-04: the non-bot PR author plus
GitHub-linked primary commit authors when the PR targets the integration branch.
Vendor agent accounts and co-author trailers do not add score recipients or
turn trailer authors into self-reviewers. The original commit messages remain
in the evidence; the collector does not resolve trailers into credit authority.
This preserves the evidence needed to distinguish shared work
from unrelated changes; it does not yet authorize scoped joint publication.
The additional evidence participates in the source digest, so old assessments
need a verified successor before they can match the expanded source record.
Incoming GitHub PR cross-references are paginated and retained by immutable ID,
public repository, number and URL. Private references are withheld and leave a
source limitation. These references are discovery metadata, not a joint source
assessment, and their absence does not prove that no other related work exists.
The evaluator can name a discovered PR in an unresolved result; a related URL
without collected reference evidence or a positive joint score is rejected.
GraphQL cross-reference reads use the existing generation budget. REST reads
contribute to the request count, and all merged outcomes receive human-decision
hydration.
Value collection also retains closed, unmerged PRs in the full scoring window.
Their complete reviews and current assessment history can award review value,
but never implementation value. Missing or unresolved decisions do not fall
back to retained legacy review awards. Reviews must precede closure and exclude
the implementation authors. Published counts and assessment coverage retain
these sources separately from merged PRs. Value hydration collects every review
state, including `COMMENTED`, on every page. Eligibility and assessed value
determine credit; collection does not discard a finding because the reviewer
did not select approve or request changes. Review awards use their submission
time within the scoring window. A later merge or closure does not move an old
review into the current month. Assessment history still retains that review.

The source collector does not call a model. A failed feed prevents snapshot
publication; legacy scoring is not a failure fallback.

Local integration used the actual Worker HTTP reader, SQLite, fresh Eliza source
and a controlled assessment fixture, then passed the loaded decisions through
the real score projection and snapshot validator. It also exercised unavailable,
redirected, wrong-identity and oversized responses, explicit empty history, and
private or unknown repository visibility. This is local ingestion evidence, not
proof of the production hostname, a new model valuation or a hosted publication.

### Recovering a confirmed review comment

A failed local comment-ID checkpoint does not authorize another GitHub comment.
When the cached ID is absent or GitHub reports it deleted, the Worker reads the
complete bounded issue-comment history before creating a replacement. It adopts
only a comment authored by the configured App bot ID with the Slopbot review
marker. A copied marker from a contributor or another bot is not authority.
Unavailable, incomplete, or ambiguous history causes a queue retry without a new
comment. Local queue/SDK/SQLite checks cover checkpoint failure after creation,
second-page recovery, foreign markers, unavailable history, and multiple matches.
These controlled checks do not prove live GitHub delivery or production activation.

### Recovering interrupted review attempts

Migration `0021_slopbot_review_leases.sql` gives each running attempt a private
claim token and a 20-minute expiry. This exceeds the documented
[15-minute queue consumer wall limit](https://developers.cloudflare.com/queues/platform/limits/).
A competing delivery retries when the lease expires; it is not acknowledged as
completed and does not spend another model call. An expired running attempt can
be claimed atomically as an unbilled retry. Completed reviews remain deduplicated.

The current claim is checked before model work and GitHub mutations. Completion
and failure updates require the same unexpired token, so an older attempt cannot
overwrite a successor. Provider receipts are still recorded if ownership is lost,
with zero customer billing for those calls. GitHub mutations and D1 checkpoints
remain separate operations; confirmed comments use the recovery path above.

Local queue/SDK/SQLite checks cover contention without inference, expired recovery,
a replaced token during inference, stale completion rejection, concurrent claims,
skip-to-funded recovery, and migration of existing running rows. Production
interruption recovery and dead-letter operations still require hosted verification.
