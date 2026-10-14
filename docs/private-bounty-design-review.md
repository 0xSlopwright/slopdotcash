# Private bounty design review

Date: 13 October 2026. Scope: product and workflow research, not a contract audit. This review supports [PRD SEC-01–18](slop-product-requirements.md#19-private-security-bounty-programs--mvp) and [MVP-13](slop-mvp-plan.md#mvp-13-delivery-and-acceptance). It does not activate a program, change Umia, approve a report or move funds.

## Confirmed product direction

The owner requested private security reporting for projects such as Umia. Suspected critical findings and anything that could cause loss of funds must take the private route. Only a human-confirmed critical vulnerability with verified funds-loss impact earns a bounty. The owner explicitly confirmed that demonstrated potential loss qualifies; actual loss is unnecessary. Other work may be accepted without a bounty.

The owner corrected the previous split to 75% researcher and 25% Slop. Each project chooses its gross bounty. Umia has a $10,000 gross commitment from Slop and a $7,500 advertised researcher award. A hypothetical $100,000 gross program advertises $75,000 for the researcher. The amount is per eligible distinct finding, not a monthly pool, loss estimate or verified account balance. The implementation must expose total capacity separately and obtain approval for its exhaustion policy.

The previous PRD placed private programs in a future phase and used a 50/50 split. Both are superseded for this MVP design. Ordinary payout fees, public review periods and public evidence rules cannot be applied mechanically to an embargoed case.

## Research observations

| Source | Observation | Design consequence |
| --- | --- | --- |
| [Umia repository at inspected commit](https://github.com/umiafinance/protocol/tree/ac59fdff2c8603ad642f2e73772871e6e0b79807) | Public Solidity protocol with Foundry build/test instructions, market, governance, launchpad and treasury components | Use exact covered source/deployment identities; repository visibility is not testing permission |
| [Umia security notes](https://github.com/umiafinance/protocol/blob/ac59fdff2c8603ad642f2e73772871e6e0b79807/docs/SECURITY.md) | Documents solvency/claim invariants and privileged trust assumptions; it is not a full audit | Distinguish defects from intended powers; agree attacker prerequisites and affected assets before launch |
| [Umia public repository API](https://api.github.com/repos/umiafinance/protocol) and [private-reporting status](https://api.github.com/repos/umiafinance/protocol/private-vulnerability-reporting) | Read-only GitHub API check returned repository ID `1262769489`, default branch `main`, and `enabled: false` on 13 October | Recheck live readiness before activation; do not advertise a working reporting form from the security file alone |
| [GitHub private report instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately) | Enabled repositories offer a private report form; reporters participate in the resulting advisory | Start with a direct private handoff and preserve access for reporters who did not join Slop first |
| [GitHub configuration and notifications](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository) | Enablement and user notification settings are separate | Test actual delivery and retain an approved emergency contact |
| [GitHub advisory permissions](https://docs.github.com/en/code-security/reference/permissions/repository-security-advisory) | Repository/organization administrators and security managers have platform access; advisory collaborators have their own permissions | Disclose GitHub's actual trust boundary rather than promise reporter-only visibility |
| [GitHub advisory API](https://docs.github.com/en/rest/security-advisories/repository-advisories) | Private reports and draft advisories have different operations and permission requirements | Do not infer report-creation authority from Slop's ordinary OAuth or bot installation; defer automated intake until qualified |
| [GitHub temporary private forks](https://docs.github.com/en/code-security/tutorials/fix-reported-vulnerabilities/collaborate-in-a-fork) | Integrations/status checks do not run; normal branch protections are not enforced during advisory merges | Require separate private exact-head tests and authorized review before remediation merge |
| [Immunefi severity classification v2.3](https://immunefi.com/immunefi-vulnerability-severity-classification-system-v2-3/) | Impact-based severity includes critical outcomes beyond direct theft; safe research uses local forks instead of harmful live testing | Use a separate loss-of-funds eligibility predicate; do not import every critical category as a paid Slop category |
| [Slop issue #452](https://github.com/SlopDotCash/slopdotcash/issues/452) | Prior design discussion identifies private reporter/fixer credit, embargo timing and deduplication gaps; issue was closed at inspection | Reuse the reasoning, but verify implementation independently; never infer a shipped credit path from closure |

Umia's README describes per-file licensing, including MIT and BUSL-1.1 surfaces. Preserve that distinction in eventual onboarding instead of calling the whole repository MIT. Address files and deployment artifacts are clues for maintainer verification, not proof that a deployment is current, funded or authorized for research. No contracts were attacked, no report was submitted, and no vulnerability or severity verdict was established in this review.

## Alternatives and selected MVP

| Approach | Benefits | Costs and limits | Decision |
| --- | --- | --- | --- |
| Public issue or PR with a security label | Existing public workflow | Leaks before a reviewer can classify it; labels do not make it private | Reject for sensitive reporting |
| Reuse Slop private traces | Existing authenticated upload and storage | Contributors and maintainers cannot read uploaded traces; retention and minimization rules do not fit technical case collaboration | Reject as the case system |
| GitHub private advisory plus private Slop decision/payment metadata | Reuses repository review authority and private collaboration; avoids a duplicate exploit corpus | Requires enabled intake, disclosed GitHub access, manual case reconciliation and independent private testing | Selected MVP |
| Full native Slop report/attachment portal | Direct control over case UX and permissions | New sensitive storage, upload execution risks, moderation, retention, secrets handling and synchronization | Future extension; not necessary for the first program |
| External bounty platform | May provide established triage, dispute handling and payment operations | Terms, fees, ownership of case access and the 75/25 arrangement need a separate agreement | Evaluate later if operational volume justifies it |
| Encrypted email alone | Possible emergency contact | No reliable shared case state, receipt/priority handling or granular revocation | Verified contingency only, not the primary bounty workflow |

This is a design selection based on the repository's GitHub-first principle and current private-trace restrictions. It is not evidence that GitHub alone supplies bounty accounting or confidential payment. Slop still needs private role-scoped records, independent security/payment decisions, funding reconciliation and operational recovery.

## Cross-flow review

- **Discovery:** show the researcher amount, criteria, sponsor, actual readiness and separate capacity. Keep program terms public without exposing open-case counts or reserve changes tied to a case.
- **Onboarding:** allow a bounty-only project, verify authority and safe scope, resolve registry migration, validate the reporting channel, and qualify the named response team. Umia's funding offer is not maintainer opt-in.
- **Research:** stop public issue/PR generation when sensitive content appears. Do not upload reproduction logs as ordinary traces or send them to unapproved model providers. Human-only reporting must work.
- **Triage:** preserve receipt time and policy revision; independently record severity and loss evidence. Reject or downgrade privately. Appeals cannot reveal another reporter's proof or depend solely on Slop's financial interest.
- **Remediation:** isolated reproduction, private patch, exact-head review, safe retest and deployment evidence. A public commit or on-chain upgrade can reveal an exploit before an advisory is published.
- **Finance:** reserve gross once, split exactly, preserve obligations through pauses and bans, and verify payments without a public cycle. The funding rail, payment asset, cost allocation and fiat reversal behavior remain launch choices.
- **Recognition:** acceptance, score, bounty and disclosure are separate. No public points or money-received update during embargo; no automatic monthly cash from a later fix PR in bounty-only mode.
- **Operations:** test outage, lost permissions, failed notification, concurrent reports, transfer uncertainty, restore and program wind-down. Restrict future intake without losing pending cases or earned obligations.

## Launch decisions still required

The product rule and 75/25 economics are settled. Each program must still approve:

1. Exact assets, versions, deployments and permitted research; severity rubric and treatment of permanent freeze, yield and privileged assumptions.
2. Duplicate priority, simultaneous discoveries, teams, known issues, related parties and regressions.
3. Total funding, concurrent-report liability, exhaustion/closing policy and the evidence that verifies available money.
4. Payment currency/rail, costs, identity/destination proof, payout deadline and any required tax/legal handling. The designation “cash” does not silently authorize USDC or any signer.
5. Authorized security and finance decision makers, independent appeals, response targets and incident escalation.
6. GitHub access/notification limitations, Slop data retention, approved processors, backups, disclosure decisions and payment privacy limits.
7. Real private-intake, access-control, remediation and settlement acceptance evidence under MVP-13 before any program is advertised as open.

These choices gate implementation of the dependent behavior and program activation; they do not prevent completing the PRD and MVP update. No new public issues, legal terms, live infrastructure or financial actions are created by this research.

## Follow-up: email, evidence and trust

The owner requested Cloudflare email readiness and explicit maintainer trust handling. PRD SEC-16–18 now require notification delivery evidence, a version-bound private submission record, four separate verification stages, and defined dispute authority. Neither a report hash nor a transfer receipt proves that a vulnerability qualifies.

Source inspection found an uncommitted `workers/notify/` implementation in the primary checkout. It sends project-application notices to a fixed admin list using an internal service binding. It is absent from the bounty documentation branch and the inspected `origin/development` tree. Its local presence is not proof of deployment, domain enablement, researcher delivery or a secure case notification flow. Preserve that work and integrate it through its owning reviewed change rather than copying it into an unrelated documentation commit.

Cloudflare distinguishes [restricted send bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/), [sending-domain onboarding](https://developers.cloudflare.com/email-service/get-started/send-emails/) and [sending limits](https://developers.cloudflare.com/email-service/platform/limits/). The first may serve verified destinations; broad researcher notifications need a qualified sending configuration. Check actual recipient eligibility and quota. Provider acceptance, inbox delivery and human acknowledgment are separate observations.

Read-only CLI checks on 13 October found that the current Wrangler account does not own the Slop zone, Pages project, notify Worker or `slop-private` database. Its one verified destination proves nothing about Slop email readiness. The browser exposes the separate Developer@elizalabs.ai account and its active `slop.cash` domain; inspect that account before any change. Never configure a replacement service in the wrong account.

Recommended trust model: evidence-bound human technical acceptance, separate financial authorization, independent appeal with explicit powers, and objective payment reconciliation. Prefunding helps only to the extent that the actual instrument restricts withdrawal and provides a release mechanism. Umia technical approval and Slop funding authority must be agreed separately. No discretionary “honor system” can honestly be described as a guaranteed bounty payment.

Browser inspection in the owning account confirmed that Email Routing for `slop.cash` is enabled with locked DNS records, and both existing application-notification recipients are verified. Email Sending currently lists only other domains; `slop.cash` is not enabled for that broader sending mode. Its activation preview proposes bounce MX/SPF/DKIM records and a root DMARC policy of `p=reject`. Activation was not submitted: the required deploy/DNS issue claim is absent. This distinction matters: existing restricted admin delivery may be possible, but broad bounty notification readiness and actual inbox delivery remain unverified.

The owning account's live Workers & Pages search returned no `slop-notify` deployment. Therefore the existing local Worker must still pass its reviewed release and production binding checks; no notification send or inbox delivery was claimed.

Follow-up activation: the owner explicitly waived the human-issue/deploy-DNS claim prerequisite for this email setup. Cloudflare Email Sending for `slop.cash` was activated in the owning account. The dashboard now reports **Sending status: Enabled** and **DNS records: Configured**, with a displayed daily quota of 200 messages. Bounce MX/SPF records also resolve publicly. This supersedes the earlier domain-activation blocker only. The notification Worker, protected release, application binding, recipient routing and actual end-to-end inbox delivery remain separate incomplete gates. No bounty report, award or payment was created by this activation.
