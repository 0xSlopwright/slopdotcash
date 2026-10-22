# Value-based contribution scoring

Owner direction, 9 October 2026, for issue #618. This extends SCR-05 and the
MVP-09 and MVP-05a work packages. The owner requested a complete September and
October review for every active project, automatic provisional scores from
Slopbot, and installation on Eliza. Human approval is still required for payouts.

## Required result

A contributor can see why an accepted outcome has its score. A small valuable
repair can outweigh a large mechanical change. A new required capability and a
substantial refactor receive different assessments when their demonstrated
value differs. The bot must inspect the work, not price lines, commits, tokens,
the author's reputation, or the number of PRs.

Each assessment binds the project, immutable repository and PR IDs, exact
reviewed and merged revisions, evidence digest, rubric version, model identity,
recording time, and predecessor. Publish the safe rationale and evidence links.
Never republish patches, review bodies, prompts, credentials, or private traces.

## Rubric

Assess these dimensions separately, with a concrete evidence reference for each:

| Dimension | Question |
| --- | --- |
| Alignment | Which approved project requirement or demonstrated user problem does this address? |
| Impact | What works better, for whom, and how important is the effect? |
| Scope and complexity | What independent behavior changes, and what makes the solution difficult? |
| Evidence | What proves the result? Distinguish reported tests from independently observed tests. |
| Maintenance | Does the change simplify the system, preserve compatibility, or create avoidable burden? |
| Originality and overlap | Is this one outcome, a partial delivery, a duplicate, a revert, or a repeated promotion? |

Use the existing integer-third tiers: micro 1, small 3, medium 9, large 24,
XL 45, exceptional 75. These are relative value bands, not money or time estimates.

- Micro: a useful but very narrow correction, documentation clarification, or
  necessary mechanical change with little independent product effect.
- Small: a bounded verified defect repair or required improvement to one path.
- Medium: a meaningful capability or difficult repair affecting a complete
  workflow, with evidence of the intended result.
- Large: a substantial required capability, broad reliability/security repair,
  or refactor with demonstrated maintenance or performance improvement.
- XL: an unusually valuable outcome across major workflows or architecture,
  with strong verification and independent review.
- Exceptional: a rare project-level advance with direct evidence. Require
  independent calibration against other top outcomes, not just a large diff.

A one-line security fix can be large. A 10,000-line generated or mechanical
change can be micro. Missing evidence produces an unresolved assessment, not
an invented low score. Suspected duplicates, abuse, and unrelated work produce
a review flag; the bot does not autonomously impose penalties or exclusions.

## Review and maintainer value

Inspect formal reviews, inline findings, responses, subsequent patches, merge
decisions, and retained fixes from closed/replacement PRs. A different head SHA
alone does not prove review impact. Identify the finding and the causal response.
Useful validation can matter without requesting changes; an approval alone is
not evidence of that work. Do not reward a request-for-changes race.

Use the existing review bands (triage 1, standard 3, deep 9, specialist 24
thirds) for distinct evidenced review outcomes. Do not reward the same finding
twice or separately reward a credited implementer's self-review. Maintainer
integration, reproduction, release work, or resolution deserves consideration
when it is independently evidenced and not already implementation credit.

## Automatic provisional publication

The bot may update provisional value scores after complete, exact-revision
assessment. Bot assessments remain distinguishable from human ratifications.
A valid human ratification takes precedence. Every revision appends a successor
and explains the change; absence or failure of assessment remains visible and
does not manufacture a successful assessment at the default tier.

Keep Slop Score, participation Points, allocation weight, approved awards, and
paid amounts separate. Apply shared-commit attribution once per logical work
unit. Grouping must reconcile contributors and preserve source credit. Do not
let split PRs, a promotion, or a repeated cherry-pick multiply one outcome.

## Historical review and payout comparison

Enumerate all repositories from active project manifests. Collect September
2026 and October 2026 through an explicit UTC cutoff. Record every source and
coverage gap. Review both accepted and closed-unmerged work so retained review
value is not lost. Open work is review context, not an accepted outcome.

Use complete repository pagination, not GitHub search as a coverage proof.
Fetch full diff/file, commit-author, formal-review, inline-review, discussion,
and replacement-link evidence. Large or truncated evidence needs explicit
follow-up. Compare like outcomes across authors and both months; do not infer
value from titles or metadata. Record disagreements and uncertain cases.

Back-valuations are append-only proposed/provisional revisions with original
occurrence dates and separate assessment dates. Preserve earlier public awards,
their policy versions, and frozen cycle bytes. Never rewrite a closed cycle or
an approved/funded/paid obligation. Any financial correction requires the
existing reviewed successor process. Participation Points history must expose
the predecessor, delta, reason, and effective decision time.

Calculate advisory contributor shares with integer arithmetic against each
manifest's applicable monthly cap. Show old/new scores, grouped outcomes,
unresolved coverage, and sensitivity to uncertain tiers. A pledged cap is not
available money. External-prize shares remain outside platform payments.

A demonstrated duplicate or promotion can receive a zero provisional value
while its accepted source remains in the census. This is not a penalty or an
exclusion decision. Missing evidence has an unresolved value, never an invented
zero. A consolidated merge receives only its distinct integration value after
the original contributions have been accounted for. Original contributors and
maintainers must not receive the same implementation award twice.

## Delivery and acceptance checklist

- [x] Refresh the visible September/October census through 2026-10-21T21:28:26.301Z from the live D1 registry: five active projects, 274 connection pages, 27,003 PRs scanned, 5,784 closures, and 4,209 merges. September has 1,460 merges and October has 2,749. Of these, 1,387 and 2,633 respectively fall within the manifest reward-start windows, before bot, attribution, overlap, and evidence checks. This is source coverage, not a completed valuation; unavailable historical nodes remain separate evidence gaps.
- [ ] Full diff and discussion evidence, with explicit missing-source coverage.
- [ ] Calibrated rubric and individual reasoned assessment for every eligible outcome.
- [ ] Reviewer and maintainer outcomes assessed without duplicate credit.
- [ ] Contributor/month comparison and advisory allocations, including uncertainty.
- [ ] Shared evaluator for historical runs and Slopbot merge/review events.
- [ ] Authenticated, exact-head, append-only provisional publication and human precedence.
- [ ] Scoring/Points consumers display and ingest the correct separate records.
- [ ] End-to-end success, incomplete evidence, stale revision, replay, and override checks.
- [ ] Protected release and production record readback.
- [x] Verified owner-completed Slopbot App installation on elizaOS (installation 169856061; all repositories selected; contents/members/metadata read, issues/PRs write).
- [ ] Live delivery, model call, score publication, and source-ledger readback.
- [ ] Human payout review remains separate; no payment is authorized by this plan.

## Known setup gaps

At initial inspection, the SlopDotCash-owned App is `slopdotcash` (ID 5257625).
The separate `slopcash` App is owned by another account and is not interchangeable.
The production Slopbot hostname did not resolve at initial inspection. The
owner-supplied Surplus credential subsequently passed local Opus and Sol runtime
checks. Production Cloudflare access and App private-key/webhook configuration
remain pending. Existing worker billing qualification is incomplete. Do not represent App installation alone as an operating bot.

The owner selected assessment within the existing ChatGPT subscription for
the historical run. Do not start paid API calls for that backfill. The ongoing
hosted Slopbot service still needs a supported model connection and its own
approved operating budget; a ChatGPT subscription is not an API credential.
