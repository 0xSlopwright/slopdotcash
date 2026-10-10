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

