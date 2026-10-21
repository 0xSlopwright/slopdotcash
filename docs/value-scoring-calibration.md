# Value scoring calibration

Status: early calibration, not a completed historical valuation or payout approval.
Scope: owner-directed September and October 2026 review under SCR-06.

## Evidence lessons from the first two complete diff and discussion reads

[Eliza #34772](https://github.com/elizaOS/eliza/pull/34772) repairs action and
permission parsing when prose contains unmatched punctuation. The accepted
patch changes the shared scanner and both consumers. Its value is the restored
agent response and permission-card workflow. The author reports differential
checks and bounded runtime. Those reports are evidence claims, not tests run by
this assessment. This is a candidate for the **medium** tier, subject to the
project-wide comparison and verification of the related earlier parser work.
The added line count is not the reason for that candidate tier.

The first [review](https://github.com/elizaOS/eliza/pull/34772#pullrequestreview-5477483761)
reports before/after execution and identifies the combined unmatched-brace and
quote failure. A later [review](https://github.com/elizaOS/eliza/pull/34772#pullrequestreview-5477500510)
identifies the same failure by static tracing. The author then reports the
[corrected result](https://github.com/elizaOS/eliza/pull/34772#issuecomment-6093689678).
The first distinct finding deserves consideration for review credit even
though its GitHub state is APPROVED. The later CHANGES_REQUESTED state does not
make the same finding a second outcome. A third review reports checks of cases
already tested; its incremental value needs to be established separately.
No score change has been applied from this calibration.

[Eliza #34761](https://github.com/elizaOS/eliza/pull/34761) repairs three tests
after source changes. The full accepted diff updates an expected error string,
supplies the flag-off value in a harness, and gates a native test on its required
jar. This is a candidate for **micro**: it restores an existing development
check, with no new product capability. The native-test skip still needs context
about the lane that exercises it; a passing skipped test is not evidence of
native security behavior.

The [request for changes](https://github.com/elizaOS/eliza/pull/34761#pullrequestreview-5477490703)
was followed by a branch synchronization, not a change to those three hunks.
A different head SHA therefore cannot prove that review caused a repair. The
preceding approvals contain source-level comparisons that may be useful
validation, but their existence alone does not justify three separate awards.

## Integration and large retained datasets

The accepted first-parent diff for [ASI #3097](https://github.com/SlopDotCash/asi/pull/3097)
contains 543 file sections. Of these, 498 have the same path and target Git blob
as another September/October ASI PR in the collected corpus. Those sections
account for 18,990,204 of its 19,262,512 diff bytes. This is an overlap signal,
not a final value assessment. The PR explicitly integrates 22 prior branches
and also reports distinct merge corrections and validation. The eventual award
must distinguish original implementation from that integration work.

[ASI #3060](https://github.com/SlopDotCash/asi/pull/3060) retains a local
144-shard development run; [ASI #3100](https://github.com/SlopDotCash/asi/pull/3100)
retains a separate hosted, source-bound run. Both contain hundreds of thousands
of generated lines. Their possible value is the measured result and the
additional execution qualification, not the JSON volume. The negative outcome
can be useful research evidence without proving a new performance capability.
These cases still require artifact and review assessment before tier assignment.

## Rules these cases require

- Assess the retained result and its counterfactual, not lines or review state.
- Credit a demonstrated distinct finding once across reviews of the same work.
- Keep static inspection, claimed execution, reproduced execution, and deployed
  acceptance separate.
- Compare reviewed and accepted code before attributing a change to a review.
- Treat integration, repeated fixes, and follow-up repairs as related work when
  deciding the value of the whole outcome.
- Preserve old scores and publish any new assessment as a reasoned successor.

## Research basis

Google's [review guidance](https://google.github.io/eng-practices/review/reviewer/looking-for.html)
centres design, functionality, complexity and tests in context. Its
[small-change guidance](https://google.github.io/eng-practices/review/developer/small-cls.html)
supports bounded coherent work rather than rewarding large diffs. Microsoft's
[SPACE research](https://www.microsoft.com/en-us/research/publication/the-space-of-developer-productivity-theres-more-to-it-than-you-think/)
explains why activity volume alone cannot describe developer productivity.
These sources inform the rubric; they do not validate any particular award.

## Merge ancestry and retained research outcomes

Delta Star [#214](https://github.com/SlopDotCash/proximityprize/pull/214)
and [#215](https://github.com/SlopDotCash/proximityprize/pull/215) carry the
same proof changes. The original result refutes a named unrestricted root-count
premise. It does not refute the production conjecture. The exact-arithmetic probe
was independently rerun successfully. The integration head's
[hosted build](https://github.com/SlopDotCash/proximityprize/actions/runs/37669982998)
passed. Count the proof once, then consider the distinct integration validation.
Do not award the earlier Binius repair in #212 again through this integration.

The relation between [#217](https://github.com/SlopDotCash/proximityprize/pull/217),
[#218](https://github.com/SlopDotCash/proximityprize/pull/218), and
[#219](https://github.com/SlopDotCash/proximityprize/pull/219) shows why a
first-parent merge diff is insufficient on its own. GitHub reports a branch-sync
commit as #218's merge. That diff contains #217's maximum-radius theorem. The
original #218 proof is preserved through #219. A scorer must inspect both the
submitted change and the integration ancestry to preserve the original credit.

The maximum-radius theorem resolves a bounded definition obligation, which is a
small-tier calibration candidate. The unrestricted refutation and the decoded-head
refutation are medium-tier candidates for distinct research results. None solves
the production prize. The #218 pre-merge review contains concrete arithmetic
verification and is a standard-review candidate even though it approves the work.
Its extra distance observation is not an implemented improvement. The #219
[integration build](https://github.com/SlopDotCash/proximityprize/actions/runs/37830112334)
passed. These are calibration candidates, not final published awards. Full-project
comparison and the separate integration/review allocation remain incomplete.

## Stacked research split, refreshed 21 October

The complete Git inventories for Delta Star #188–#192 match GitHub's reported
submitted file counts. The REST file lists stop at 3,000 entries for these PRs.
Use their immutable Git trees to cover the omitted files.

| PR | Submitted file entries | First-parent accepted file entries |
| --- | ---: | ---: |
| [#188](https://github.com/SlopDotCash/proximityprize/pull/188) | [3,529](https://github.com/SlopDotCash/proximityprize/compare/aeb2a3eb0a25de1d010167911bc836724c54e2fe...577b06b6d3e6857bcea8bb5b159c947f144807e7) | [3,529](https://github.com/SlopDotCash/proximityprize/commit/d877638fd0aacab2c560e26f47d98577d5212096) |
| [#189](https://github.com/SlopDotCash/proximityprize/pull/189) | [3,541](https://github.com/SlopDotCash/proximityprize/compare/aeb2a3eb0a25de1d010167911bc836724c54e2fe...8b4582342bd498471b6a787d903dc742fb540ce4) | [13](https://github.com/SlopDotCash/proximityprize/commit/36dedf10c818a1bbe4815ef54955f1765d01cbfb) |
| [#190](https://github.com/SlopDotCash/proximityprize/pull/190) | [3,784](https://github.com/SlopDotCash/proximityprize/compare/aeb2a3eb0a25de1d010167911bc836724c54e2fe...c22062892210404649e5133e8226d6f512ea426f) | [2](https://github.com/SlopDotCash/proximityprize/commit/3bc8d7e82e377260c1f1bc3102e1b897cc719d37) |
| [#191](https://github.com/SlopDotCash/proximityprize/pull/191) | [3,917](https://github.com/SlopDotCash/proximityprize/compare/aeb2a3eb0a25de1d010167911bc836724c54e2fe...4999165d96d394c8e7302a116ca2d16d1cba8e57) | [176](https://github.com/SlopDotCash/proximityprize/commit/cf7128d8a15cff757a8ce157666491574db6804e) |
| [#192](https://github.com/SlopDotCash/proximityprize/pull/192) | [3,920](https://github.com/SlopDotCash/proximityprize/compare/aeb2a3eb0a25de1d010167911bc836724c54e2fe...a5f11522480ff3da0546902b0f5090165b5e72bc) | [2](https://github.com/SlopDotCash/proximityprize/commit/12e6b0db6b54e5b06397cf3ee3914966796a8f57) |

In #188, 1,510 moves retain identical blob contents. These counts establish
scope and overlap, not value. Review the retained module boundary, changed
imports, proof content, and build evidence together. Do not award five large
refactors from the submitted totals, or discard original authors because a
later integration carries their commits. Individual tiers and any distinct
integration or review credit remain unresolved until that joint review finishes.

## Competing certificate-memory repairs

Delta Star [#186](https://github.com/SlopDotCash/proximityprize/pull/186) splits
the R394 finite box into separately checked slices.
[#187](https://github.com/SlopDotCash/proximityprize/pull/187) instead transports
the field equation to integer divisibility. Both also reuse the R394 result
for R395. [#193](https://github.com/SlopDotCash/proximityprize/pull/193) retains
the integer approach in the relocated Research tree. Inspect the
[accepted R394 source](https://github.com/SlopDotCash/proximityprize/blob/52b1a416bf80837bbeb737eaea7f8f0c65646b3c/Research/ProximityPrize/Frontier/_R394L1KernelCertificate.lean)
when separating original repair value from integration value.

Independent integer enumeration checked all 28,561 box points. Of these,
1,289 satisfy the L1 bound of six. Only the zero vector vanishes modulo 1409
with coefficients 1, 72, 5184 and 373248. This supports the finite arithmetic
claim. It does not prove Lean elaboration, kernel acceptance, measured memory
savings, or a successful hosted build.

The two formal reviews explicitly report static inspection without Lean
execution. Their reviewed heads also precede later changes. Preserve those
limits when evaluating review value. Do not award three independent memory
repairs from these three merges. The integration's broader source coverage,
original attribution, distinct integration work, and final tiers remain open.

The complete accepted diff for #189 moves two reusable algebra modules, updates
imports, and adds a focused validation record. All three source hashes in that
record match the accepted Git blobs. The accepted diff for #190 adds a
restricted-sumset audit and updates its guidance; all eight reported source
hashes match that accepted tree. These matches establish which bytes the reports
refer to, not independent execution of the reported Lean checks. The accepted
#192 diff changes only the README and repository map to explain build surfaces.
Its large submitted diff must not turn those two documentation changes into a
second full refactor award. Original stacked commits still need joint credit.

## Dependency updates after a workflow replacement

The [September site rewrite](https://github.com/SlopDotCash/proximityprize/commit/e0f9de09e4b80b251b478f320cb467a4f3b08dfc)
changed the site's Wrangler action from v4 back to v3, Node setup from v7 to
v4, and artifact upload from v7 to v4. The later October dependency updates
therefore operate on a regressed baseline. Repeated version numbers alone do
not establish duplicate work or abuse.

The ten inspected dependency PRs (#173–#177 and #207–#211) have the same verified
GitHub Bot author. Apply the existing bot eligibility rule separately from
review value. The #175 review reports comparing Wrangler CLI flags and action
inputs, while explicitly excluding a real deployment. The October reviews
mostly assert input compatibility without execution receipts or direct
compatibility citations. Preserve this difference in evidence strength; neither
review text nor this comparison proves a successful Cloudflare deployment.
