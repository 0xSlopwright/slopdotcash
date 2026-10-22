# Objective quality closure proposal

Status: proposed for human approval. The repository owner requested this
amendment on 21 October 2026. It does not enable closure or approve its rules.
Scope: PRD BOT-06, BOT-12 and MVP-05a.

## Problem

The current bot can label `low_quality` work but cannot close it. A broad
quality judgment is not enough evidence to reject useful work.

## Proposed rule

A repository may enable `low_quality: close` only with a published rejection
rule in its base-branch contribution guidance. A closure must identify one of
these objective failures:

- The patch replaces required working behavior with a placeholder or removes
  it without an approved scope change. Name the required behavior and changed lines.
- The patch introduces a reproduced failure in an unchanged required workflow.
  Give the command, environment, baseline result and failing candidate result.
- The contribution claims test or result evidence that the cited artifact
  demonstrably contradicts. Quote the claim and link the exact contradictory
  evidence. Missing evidence alone does not meet this rule.

Use existing `empty`, `duplicate`, `busywork` and `out_of_scope` categories when
those rules describe the defect. Do not relabel them to evade their safeguards.
A model's opinion, style preference, unfamiliar implementation, author identity,
model choice, diff size, or lack of tests alone cannot justify quality closure.
A failed external service or unrelated failing check is not a patch defect.

## Required evidence and controls

Both independent verdicts must cite the same objective defect. Each must pass
rule-quote and source-evidence checks. Confidence alone is insufficient.
Tests run only in the approved isolated verification environment. The model
cannot execute a contributor's code or treat reported tests as reproduced tests.
If that environment or evidence is unavailable, label the item for a maintainer.

The close comment states the published rule, exact source revision, evidence,
repair needed, and appeal path. Recheck the source, live project registry,
installation, exemption, assignment and repository policy before acting.
A changed source requires a new review. An appeal or maintainer reopen prevents
another close of the same revision.

Keep explicit repository enablement, the global closure switch, the later of
14 days or 50 reviewed items in shadow mode, independent confirmation, the
25-per-day default cap, and the reopen-rate circuit breaker. Record maintainer
agreement for the proposed quality closures during shadow review.

No new penalty, exclusion, reward change or payment follows from this amendment.
The existing separate human and financial authority rules remain in force.

## Approval and acceptance

Before implementation, maintainers must approve these criteria, update BOT-06
and MVP-05a, and publish an effective date in the versioned protocol. Then test
real examples of each accepted rejection rule and useful counterexamples.
Verify unchanged-head closure, source changes during review, missing evidence,
provider failure, unavailable verification, exemptions, appeals and reopen.
A local result cannot replace live hosted workflow evidence. Enable production
closure only through its separate reviewed activation after shadow qualification.
