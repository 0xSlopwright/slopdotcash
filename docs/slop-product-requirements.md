# Slop Product Requirements

Product requirements • 22 October 2026

Make money shipping open source.

Contributors submit useful work in GitHub. Maintainers accept the work. Slop shows the score, reward decision, and verified payment.

This repository PRD is canonical. The [Google Docs mirror](https://docs.google.com/document/d/1on3Ge018mShloCpxVMs62ZCA81YA1U3HUv2s-VV7cWo/edit) provides a formatted copy. It includes product requirements, MVP delivery, acceptance, open decisions, and issue coverage.

This edition does not establish implementation, release, or payment approval. Unresolved decisions remain open.

## 1. Product and scope

The minimum viable product (MVP) must complete the journey from finding work to receiving a verified payment.

- Contributors find suitable work, use any disclosed agent or model, and submit a pull request (PR). Manual contributions remain supported.

- Maintainers set project rules, accept work, approve awards, and manage funds.

- Depositors fund a project after they review its fees and refund terms.

- Operators manage access, incidents, project admission, and appeals.

- Security researchers submit private reports and receive the published award when an authorized human confirms eligibility.

Measure success by contributors with accepted work and a finalized payment in each UTC month. Also measure review effort, payment failures, and reconciliation errors.

The MVP includes accounts, wallets, project setup, generated skills, Slopbot, security checks, rankings, project vaults, and private bounties. It includes Base, Solana, Robinhood Chain, and Ethereum. Each network supports its approved stablecoin or a supported project token. Fee-wallet conversion is also in scope.

Later work includes more networks, bridges, token creation, brokerage features, more wallet types, and automatic private report submission. Swaps within contributor payments remain excluded.

Only owners and maintainers open issues, from 19 October 2026. Contributors use existing issues or approved requirements. An issue does not approve a new feature.

Maintainers must approve scope and delivery changes in this PRD before work starts. Future work requires a recorded MVP completion decision.

## 2. Authority and records

- GitHub establishes repository identity, permissions, work, and acceptance.

- The D1 database holds the only project inventory. An admin approves each permanent project revision.

- The account service holds private settings, sessions, social links, and wallet records.

- Authorized humans approve awards. Finalized chain evidence proves deposits and payments.

- A score, model result, device signature, or database entry cannot replace another required proof.

GitHub stewardship does not establish copyright ownership, legal capacity, or wallet control. Unknown ownership remains valid. Signed ownership terms require their own evidence.

Keep the current rule version and its effective date with each record. Preserve historical awards, fees, sources, and receipts.

## 3. Accounts and wallets

ACC-01–05; SOC-01–02; WAL-01–05

Use GitHub as the only login method. Preserve the account through a handle change with the permanent GitHub actor ID.

Put Profile, Connections, Wallets, Payouts, Notifications, and Sessions in one account area. X and wallet setup are optional until needed.

Keep directory membership private until the user chooses public display. Public GitHub work remains public. X connection does not authorize posts or messages.

SOC-02 — Optional Telegram connection. This carries the requirement in PR #981 into the consolidated PRD; owner approval is recorded by its merge. Connect only from a signed-in GitHub account. Use a single-use t.me/<bot>?start=<code> link that expires after ten minutes. Only the bot's receipt of /start <code> in a private chat, authenticated by the webhook secret header, proves the numeric Telegram account ID. Reply only in that chat. Load no Telegram scripts or frames. Never request a phone number or Telegram password.

Store only the numeric ID, optional username snapshot, verification time, and visibility choice. Do not store a phone number, display name, photo, chat history, or group membership. Reserve the Telegram identity to the first GitHub identity that verifies it. Disconnect hides the link but keeps that reservation. Public display requires both public membership and public-link consent. Award no points or GitHub, project, organization, wallet, or payment authority. Telegram failure must not block GitHub work or payments. Group gating and community bot replies are outside SOC-02.

Keep web, contributor-client, and operator access separate. Support logout, access removal, private recovery, and account closure.

A wallet connection requires a fresh signature and consent for the exact account, network, and destination. Never request a seed phrase.

Allow one active destination per network. Preserve wallet history. Hold the destination fixed while a payment is in progress.

An uncertain transaction requires reconciliation before a retry. Do not change its destination silently.

Recognize accepted work before account or wallet setup. Reserve approved funded awards for the permanent actor. A valid later wallet enables eligible payment.

Recovery that redirects identity or payment requires two authorized operators. A proposed 24-hour wallet-change delay still needs policy approval.

## 4. Projects and contribution skills

PRJ-01–05; SKL-01–07

Project setup has five steps: repository, contribution rules, rewards, funding, and review. Save progress without credentials.

Verify repository authority and license facts. Show the public page and both skills before submission. An admin first approves a paused project.

Activation requires approved policy, reviewed skills, security clearance, and the applicable funding and authority checks. A submitted application is not an active project.

Generate contributor and reviewer skills from one template of each type and the approved D1 revision. Keep no separate project skill copies.

Bind each generated skill to the template revision on main and the D1 revision digest. Verify exact bytes before execution.

The main skill supports discovery outside a repository and work inside a known repository. Recheck live GitHub before selecting or submitting work.

Respect assignments, reviews, drafts, security restrictions, and maintainer claims. Do not create work to earn points.

Each submission explains the problem, approved requirement, useful result, implementation choice, and real workflow evidence.

Each Slop PR includes the visible line Made via @slopdotcash and required signed attribution. Disclose the exact provider, model, and client.

Follow the effective trace policy. Contributors inspect and redact permitted uploads. Keep private traces private. Usage totals never determine rewards.

Economic changes apply prospectively. A project update cannot reduce an existing funded award.

PRJ-05 — Referral attribution. A project link may include ?ref=<github-login>. Show the referrer and let the applicant clear it. At submission, resolve the live login to a Slop account. Store its immutable GitHub actor ID and login. Approval copies them to the project. Both records are then fixed.

Reject the applicant, manifest steward, admins, and moderators as referrers. Explain the refusal; do not silently remove the referral. Allow one referrer for the project's life. This is attribution only. It grants no points, score, reward, or payment. A paid program requires separate approved scope, legal review, and funding.

## 5. Slopbot

BOT-01–13; LDR-04; objective quality closure amendment

Slopbot is optional. Show its actual health and the next required action. A saved setting does not prove readiness.

The 21 October decision limits operation to public repositories of active projects in the live D1 registry. It supersedes protection-only installations.

Recheck registry scope before queueing, model calls, and GitHub writes. Stop on a registry failure. Stop stale jobs after suspension or removal.

Participants-only review is the default for funded projects. A visible marker or registered actor establishes review eligibility. External review needs an explicit setting.

Apply security restrictions, repository scope, and ignore rules first. Keep review exemptions separate from payout exclusions. Unknown membership cannot authorize closure.

Review the exact source revision against approved base-branch rules. Treat proposed policy changes as work under review.

Run untrusted code only in the approved isolated environment. Keep secrets and posting credentials outside it. Report tests not run.

The source specifies Surplus Opus 5.5, with OpenAI GPT-6.1 Sol as fallback. Disclose the route and unverified served-model identity.

The source has conflicting confirmation-provider rules. Resolve them before closure activation.

Charge metered cost plus 10%, with a prepaid balance and hard budgets. Do not bill failed calls or Slop-caused retries.

Offset a project's monthly invoice with its payout fees from that month. Only an owner can authorize a charge against free vault funds.

Keep an immutable cost record. Reconcile invoices. Email admins at each $500 monthly API-cost milestone without duplicate alerts.

Closure requires explicit settings, grounded evidence, independent confirmation, an unchanged revision, and an appeal route.

Shadow review must meet both 14 days and 50 reviewed items. The default limit is 25 closures per repository per day.

Return to label-only operation if more than 10% of closures reopen within seven days. A maintainer reopen protects that revision.

Objective quality closure covers only removed required behavior, a reproduced workflow regression, or demonstrably false evidence. Missing tests alone do not qualify.

Production closure needs separate approval after qualification. Its effective time cannot precede 1 November 2026 at 00:00 UTC.

Slopbot cannot merge, approve awards, or ban people. Closure and financial penalties remain separate decisions under the published policy.

## 6. Funds and payments

FND-01–06; PAY-01–10; TOK-01–07

Use one project vault, one network, one reward asset, and one deposit balance. Retired funding systems remain historical records only.

Anyone can deposit. Before signature, state that only the project owner can withdraw free funds to the recorded refund destination.

Depositors receive no separate refund right. Reserved awards and fees cannot be withdrawn.

Use the approved stablecoin or a supported ERC-20 or classic SPL token. Exclude transfer-fee, rebasing, and Token-2022 tokens.

Verify exact asset identity, decimals, transfer behavior, and finality before activation. Freeze the network and asset while funds or obligations exist.

Use exact integer base units. Do not add unlike assets or present tokens as dollars.

Keep award states separate: projected, under review, approved, and excluded.

Keep payment states separate: underfunded, awaiting wallet, ready, held, submitted, and paid. A failed attempt does not cancel the award.

Monthly allocations retain complete sources, fixed caps, integer allocation, and 14-day review. Record zero-award months. Rollover does not raise a later cap.

The owner approves amounts. The vault reserves each gross award once. Automatic execution applies only to approved, funded obligations.

For each gross award, fee = floor(gross / 50). The contributor receives gross minus fee. Apply the same 2% formula to free-fund withdrawals.

Example: a 100 USDC award pays 98 USDC to the contributor and 2 USDC to the fee wallet.

Project-token awards pay both amounts in that token. Do not charge again at claim or retry. Historical obligations keep their recorded terms.

A project-operated or permissionless executor submits payments. Slop does not operate a payment key or relayer.

The approved identity-attester design requires both authenticated account evidence and the destination wallet's signature. It includes delayed activation, cancellation, and controlled key replacement.

An attester signature alone cannot bind a wallet. A wallet signature alone cannot prove control of the GitHub account.

Mark paid only after finalized evidence reconciles the exact obligation, asset, destination, principal, and fee. Prevent duplicate payment.

A failed transfer leaves its amount unpaid and reserved. One failed recipient must not stop all other recipients.

Fee conversion occurs only after fees reach the fee wallet. It cannot affect contributor payments or vault funds.

Conversion starts in dry-run mode. Signing requires approved routes, slippage limits, minimum amounts, and activation for each network.

The conversion key has no vault role. Output returns only to the same fee wallet. Humans manage keys and withdraw proceeds.

The identity-attester and fee-wallet keys are recorded design exceptions to older no-key instructions. Resolve governing instructions before implementation or activation.

## 7. Scores, discovery, and clear pages

SCR-01–06; LDR-01–04; DSC-01–04; UX-01–17; ELG-01–03

Keep three measures distinct: Slop Score for accepted-work value, Points for nonfinancial recognition, and Money received for verified ordinary payments.

Default rankings to Slop Score. Preserve equal ranks, shareable filters, exact periods, and source coverage. Missing data is not zero.

Share merge credit with verified commit authors under SCR-04. Do not reward the same commit twice. A recipient's own review earns no review credit.

Ordinary review credit requires a request for changes that changed the accepted outcome. At most one ordinary review award applies per merged PR.

Preserve the two SCR-05 cutoffs. Public Score and Points use 1 October 2026 at 00:00 UTC.

Payment weights use 9 October 2026 at 23:21:35.388 UTC and policy scr-05-payments-production-v1. Preserve earlier qualifying review weights and closed cycles.

Models may publish provisional value scores. Human-ratified scores take precedence. Human payout approval remains required.

Preserve the required September and October 2026 assessment across active projects. Keep distinct contributor, reviewer, and maintainer outcomes.

Record qualifying penalties and reversals once. Reopen, appeal, and retry cannot multiply a debit. New point and penalty values still require approval.

Show issue and PR outcomes separately, with denominators and unknown states. Ratios do not create extra penalties.

Keep Slopbot in an Automation section outside human rankings. Label recovered costs as cost recovery, not earnings.

Use explicit payout exclusions for owners, funded employees, and related parties. Apply changes prospectively. Excluded weights cannot reduce other contributors' shares.

Human decisions require reasons and appeals. A ban does not erase a funded award.

Make Featured and Community projects easy to find. Show real funding, suitable work, and freshness. Featuring does not guarantee payment.

Use one account area, one shared ranking view, and one status summary per project. Put restrictions beside the affected action.

Preserve public links, downloads, exact amounts, and evidence details. Use the existing design tokens.

Support mobile, keyboard access, screen readers, reduced motion, and 200% zoom. Meet WCAG AA accessibility requirements.

Keep loading, empty, stale, invalid, denied, unavailable, and failed states distinct. Each failure needs a useful next action.

## 8. Security and private bounties

VET-01–08; ADM-01–06; SEC-01–18

Security clearance applies to the exact source, dependencies, skills, and artifacts. Featured status does not bypass it.

Use a disposable isolated virtual machine for untrusted execution. Block real credentials, host access, and unapproved network traffic.

Capture process, file, and network evidence. Quarantine new binaries and hidden executable content before execution.

Require independent Astra-class and Opus-class reviews with pinned identities. Missing evidence, missing models, or incomplete observation blocks clearance.

Quarantine suspicious revisions. A confirmed-malware ban requires verified evidence and the approved standing policy. Reinstatement needs independent review and a fresh scan.

Community contribution setup uses the approved isolation profile. Without it, offer read-only work or environment setup.

Private bounties require project opt-in, verified private GitHub intake, approved terms, funding, named decision makers, and an independent appeal process.

Route exploitable findings privately, including suspected critical defects or potential funds loss. Privacy does not depend on bounty eligibility.

An eligible bounty requires human-confirmed critical severity and a reproduced path to covered funds loss. Real loss is not required.

Private security bounty commission is 25% of the gross award for slop.cash. The researcher receives 75%.

This replaces the ordinary public-work commission for that award. Do not add the public 2% fee or another claim fee.

Example: a 100 USDC private bounty pays 75 USDC to the researcher and 25 USDC to Slop. Public work pays 98 and 2.

Use separate private obligations and payment records. Reuse approved verification and wallet controls without exposing cases through public payout records.

Use exact amounts divisible by four minor units. The report and fix are one financial work unit unless approved terms state otherwise.

Slop's Umia commitment is $10,000 gross: $7,500 for the researcher and $2,500 for Slop. It does not prove funding or activation.

Use GitHub private advisories for technical evidence. Keep separate restricted Slop records for terms, decisions, appeals, and payment evidence.

Human confirmation of a real report establishes submission. A draft, redirect, pasted link, or uncertain response does not.

Separate receipt, remediation, award, payment, and disclosure states. A fix or payment never authorizes publication.

Restrict each case to authorized roles. Keep case data, identifiers, counts, and revealing totals out of public exports.

Use generic private notifications. Verify actual email delivery and human acknowledgment separately. Preserve reports when notifications fail.

Use independent private review and exact-revision tests for fixes. Verify deployed mitigation separately.

Approve funding capacity, duplicate rules, deadlines, payment method, and dispute authority before opening a program. Preserve existing obligations during closure.

Private bounty implementation decision — 22 October 2026 (PR #1011). The repository owner approved reuse of existing payment rails, destination authorization, execution recovery, and canonical finality verification. Unresolved sends stay held. Only proved finalized failure permits a fresh attempt. A finalized successful payment is immutable. Use the 75/25 split without the ordinary payout fee.

Keep case records, decisions, payment records, queues, counters, and notices restricted. Use a separate bounty vault and private ledger. Ordinary balances, cycles, and account views must reveal no case-related amounts or deltas. Before a financial approver prepares an unsigned owner commitment, the reporter must accept public-chain visibility of actor number, addresses, timing, and amounts. Put no case reference or report digest on chain. Never silently convert a USD obligation into USDC.

Umia is an example, not an implementation dependency, special rail, or activation target. This decision permits implementation and synthetic tests only. It does not open a program, approve an award, deploy a mainnet contract, send a live payment, or authorize disclosure.

Any registered user may report. Designated project maintainers review through current program roles. Reporters cannot review their own reports. Technical and financial decisions stay independent. The owner authorized lalalune and SlopDotCash/slopdotcash for synthetic hosted tests. One account can prove reporting and refusal of self-approval; it cannot prove completed independent approval.

## 9. Operations and launch decisions

ARC-01; NOT-01; DEP-01; source sections 17–23

Public pages read cached D1 data or published snapshots. Background jobs collect GitHub and finalized chain data.

Show observation times. Keep the last good value with a stale label when refresh fails. Sensitive actions still recheck current authority.

Reuse the existing application, identity service, journals, and verification code. Separate permissions without adding services unless required.

Keep contributor traces, security-scan evidence, and private bounty cases in separate access systems. Test recovery and notification failures.

Development deploys to staging.slop.cash with isolated storage and credentials. Main deploys to slop.cash through reviewed promotion and protected workflows.

Approved pilot identities: lalalune (18633264) and drew-dot-com (202660855) are staging moderators and initial vetting evidence operators. Configure each role explicitly. A different moderator reviews reinstatement. Production requires staging evidence and a reviewed release.

Evidence access requires a current external-controls attestation, a reasoned grant, and an audit record. These identities do not gain contributor-trace, payment, signing, or score authority. Their selection does not prove retention, backup, recovery, or legal-hold controls.

Qualify the isolated Linux/KVM host and exact runtime profile before live repository execution. Unsupported execution remains incomplete. Use exact-head browser and staging evidence before promotion. Restore bounded browser dependency installation with cleanup; old deployments do not prove new source.

The following decisions remain gates, not permission to select a default:

- Product and protocol owners: reconcile trace, scoring, key, and source-policy conflicts; approve new points and penalty values.

- Security owners: approve wallet-change timing, funded-award expiry policy, recovery, contract review, and exact authority controls.

- Finance and security owners: verify assets and finality; resolve fee-conversion routes, limits, and Solana role separation.

- Repository owner: settle Robinhood Chain identity authority, the first project, and permission for mainnet execution.

- Security and bot owners: resolve confirmation-provider requirements before production closure.

- Program owners: approve bounty capacity, loss definitions, costs, safe testing terms, deadlines, and binding dispute powers.

- Legal and privacy owners: complete applicable reviews for fees, identity attestation, prepaid balances, retention, and private programs.

A release requires this PRD's evidence and a named human decision. This document does not declare the MVP complete.

## 10. Confirm policy

MVP-00 • Product owner and maintainers

Use the approved requirements and recorded decisions. Resolve conflicts before implementing the affected rule.

- Confirm one effective trace and scoring policy.

- Reconcile the key exceptions, current funding model, and governing repository instructions.

- Resolve the open decisions in product requirements section 9.

- Record each decision owner, approval, effective date, and requirement ID.

Exit: affected requirements and protocols agree. Unresolved gates remain visible.

## 11. Establish accounts and safe admission

MVP-01, MVP-02, MVP-12 • Identity and security owners

Deliver GitHub accounts, optional X and Telegram connections, sessions, privacy, wallet proof, and recovery. Qualify wallet flows independently on all four networks. MVP-01 requires real Telegram bot webhook delivery against the exact head; local simulations do not prove provider activation.

Deliver revision-bound security checks before executable onboarding. Use an isolated virtual machine, controlled network access, artifact quarantine, and independent model reviews.

- Test real login, rename, denied access, session removal, and recovery.

- Test wrong-network signatures, reused challenges, concurrent wallet changes, delayed activation, and unsupported wallets.

- Test harmless secret-access probes, blocked network escape, hidden payloads, and lost monitoring.

- Prove that unreviewed artifacts cannot execute.

- Keep missing models or incomplete evidence blocked.

Exit: users retain their identity and awards. Contributors cannot start unreviewed code through the offered workflow.

## 12. Publish projects and complete a contribution

MVP-03, MVP-04 • Project and skill owners

Deliver resumable project setup, authority checks, admin decisions, and permanent D1 revisions.

Generate both skills from the approved revision and canonical templates. Verify their exact bytes and authorization.

- Complete the five setup steps with a real authorized repository.

- Reject stale edits and revoked permissions.

- Verify that repeated generation produces identical bytes.

- Start outside a checkout and find bounded, eligible work.

- Complete a real contribution with exact-revision evidence and required attribution.

- Verify that contributors cannot use the skill to open issues.

Exit: one maintainer publishes an approved project. One contributor completes its real workflow using a cleared revision.

## 13. Qualify Slopbot and scoring

MVP-05, MVP-05a, MVP-09, MVP-09a • Bot and scoring owners

Deliver optional reviews, current registry checks, cost records, invoices, provisional value scores, and separate human rankings.

Protection-only installations are superseded. Test active registered public repositories and refusal of every ineligible project state.

- Test marked authors, registered authors, external authors, unknown membership, ignored actors, and verified role exemptions.

- Test disabled, incomplete, degraded, suspended, and ready states.

- Stop stale jobs after source changes, permission loss, project suspension, or App removal.

- Test provider failure, budget exhaustion, invoice reconciliation, and duplicate cost alerts.

- Verify all-project September and October assessments and a live Eliza score projection.

- Verify shared commit credit, outcome review credit, equal ranks, missing data, and complete source coverage.

For payment weights, use scr-05-payments-production-v1 at 9 October 2026, 23:21:35.388 UTC. Public Score and Points retain the October 1 cutoff.

Closure requires separate qualification and activation. Keep it disabled until policy, provider confirmation, shadow review, and release gates pass.

- Test the three approved objective defects and useful counterexamples.

- Verify grounded independent verdicts on the same defect.

- Verify exact-revision checks, appeals, reopen protection, daily limits, and the reversal-rate stop rule.

- Verify that closure cannot create duplicate penalties or change an approved award.

Exit: real hosted reviews and projections work. Closure evidence meets both 14 days and 50 reviewed items.

The earliest policy effective time is 1 November 2026 at 00:00 UTC. That date alone does not enable closure.

## 14. Prove funding and payment

MVP-05b, MVP-06, MVP-07, MVP-07b, MVP-07c • Protocol, security, and finance owners

Deliver the shared vault rules, EVM contract, Solana program, asset checks, approvals, payment execution, and finality verification.

MVP-07a is retired. Do not restore its legacy settlement route.

Run the following scenario on Base Sepolia, Solana's approved test cluster, Robinhood Chain Testnet, and Ethereum Sepolia.

1. Fund the vault with 1,000 units of its approved test stablecoin.

1. Approve 100 gross for a registered actor and 50 gross for an actor without a wallet.

1. Reserve 150. Verify that 850 remains free.

1. Pay 98 to the first contributor and 2 to the fee wallet.

1. Register the second wallet. Pay 49 to that contributor and 1 to the fee wallet.

1. Repeat dispatch. Verify that no second payment occurs.

1. Withdraw the remaining 850. Verify 833 to the owner's refund destination and 17 to the fee wallet.

1. Rebuild the records. Reconcile all balances, obligations, and receipts.

Also prove third-party deposits enter the same balance. Reject withdrawals to another destination and withdrawals of reserved funds.

Repeat the complete workflow with supported project tokens and decimals 0, 6, 9, and 18.

- Reject wrong assets, wrong networks, transfer-fee tokens, and unsupported token behavior.

- Test frozen tokens, failed recipients, low gas, partial results, uncertain sends, and queue restarts.

- Test manual and automatic execution against the same duplicate-payment controls.

- Prove that wallet impersonation, stale bindings, and cross-network replay cannot redirect an award.

- Verify service charges use only free funds and apply once per invoice.

- Verify fee conversion in dry-run mode and with an authorized testnet signature.

- Reject unapproved routes, excessive slippage, and amounts below the minimum.

- Prove that conversion failure leaves contributor payments unchanged.

Use the specified test assets. Establish the Robinhood test USDG supply route before testing. A substitute token does not satisfy that check.

Exit: independent review and all network scenarios pass. Testnet evidence does not approve mainnet activation.

## 15. Complete private bounties and product flows

MVP-08, MVP-10, MVP-13 • Product, operations, privacy, and security owners

Complete exclusions, appeals, account pages, project pages, rankings, notifications, and admin controls.

Reuse existing components. Remove repeated explanations before adding controls. Preserve required consent, exact amounts, source links, and old URLs.

- Compare the same desktop and mobile workflows before and after each UI change.

- Test keyboard access, screen readers, 200% zoom, and WCAG AA.

- Verify copy feedback, downloads, links, console output, and first-party requests.

- Verify cached public reads when GitHub and chain providers are unavailable.

- Verify that project bans also block direct skill routes and stale cached access.

For private bounties, use synthetic security cases in an authorized test repository. Keep technical evidence and videos private.

- Verify real private intake, original receipt time, role removal, and cross-case access refusal.

- Reproduce potential funds loss safely. Record separate technical acceptance and award approval.

- Test exact 75/25 splits, duplicates, conflicts, concurrent reservations, and exhausted capacity.

- Test missing wallets, changed destinations, partial payments, uncertain sends, and repeated dispatch.

- Test notification delivery, failure, escalation, and explicit human acknowledgment.

- Inspect all public exports for case data and revealing totals.

- Verify that a fix, payment, or expired deadline cannot publish a case.

- Preserve obligations through project closure, transfer, ban, and account recovery.

Exit: the complete private-bounty acceptance matrix passes. Each program still needs its own approved terms, verified funding, and activation decision.

Umia is an example, not an implementation dependency or activation target. Its funding commitment is not a verified deposit.

## 16. Migrate and release

MVP-11 • Release and operations owners

Preserve permanent identities, journal history, wallet proof levels, historical terms, and receipts. Reconcile old transfers before creating new obligations.

Use a scoped branch from current origin/development. Preserve unrelated local work. Rebase before final review and install the pinned dependencies.

- Run the required repository checks, bun run verify, and real-browser end-to-end tests against the exact head.

- Attach repeatable steps, expected results, actual results, and the tested revision.

- For UI changes, upload a walkthrough and evidence video.

- Verify isolated staging login, writes, storage, and credentials.

- Promote to main through a reviewed PR and the protected production workflow.

- Verify served files, API changes, DNS, TLS, redirects, and headers separately.

- Verify contract deployment and actual authorized payments separately.

- Test recovery, access removal, alerts, incident ownership, and reconciliation.

Humans deploy mainnet contracts and manage keys. A limited production pilot requires explicit authorization and the remaining legal and security reviews.

Rollback may stop new actions. It cannot erase history, reverse a finalized transfer, or restore an obsolete wallet.

## 17. Completion record

Maintainers record completion only after every requirement has evidence and every blocking defect is resolved.

- Name the responsible owner and approval date.

- Link every requirement and package to its tested and deployed revisions.

- Link real workflow, provider, security, chain, and recovery evidence.

- Record unresolved limits and any justified inapplicable checks.

- Approve the next phase separately.

A document, local test, merge, or deployment alone does not establish MVP completion.

## 18. Private bounty acceptance

SEC-01–18; MVP-13. Complete these checks on isolated staging with synthetic cases and an authorized GitHub repository.

Use separate technical and financial approvers. The reporter cannot approve their own report or award. Keep evidence and case references private.

- Programs: configure different project amounts and sponsors. Verify permanent revisions and bounty-only setup without a monthly pool.

- Amounts: prove 10,000 splits into 7,500 and 2,500. Reject inexact minor-unit splits and additional ordinary fees.

- Intake: test enabled, disabled, stale, denied, unavailable, direct, and interrupted reporting. Never use a public fallback.

- Receipt: verify report existence, authorship, original time, policy, and evidence version. Reject forged links and silent evidence changes.

- Eligibility: verify critical severity plus potential funds loss. Reject automatic awards for severity alone or unproven loss.

- Remediation: reproduce safely, review the exact private patch, test independently, and verify deployed mitigation separately.

- Access: reject cross-case and cross-project reads. Remove access after role loss, transfer, logout, and session revocation.

- Duplicates: preserve report priority. Prevent two reservations for one finding. Resolve conflicts through an independent reviewer.

- Capacity: verify funds separately from pledges. Test concurrent reservations and exhaustion. Preserve emergency intake and existing obligations during pauses.

- Umia: prove the gross reserve and researcher payment. Do not invent a self-transfer or external revenue for Slop's retained share.

- Recovery: test missing wallets, changed destinations, wrong payees, wrong assets, partial payments, uncertain transfers, reversals, and restarts.

- Privacy: inspect public pages, APIs, caches, logs, analytics, downloads, rankings, and notices. Exclude case identifiers, counts, and revealing totals.

- Disclosure: bind approval to exact redacted content and embargo changes. Separate reporter recognition consent from vulnerability disclosure.

- Compatibility: prevent another cash award for a later public fix. Preserve ordinary rewards for separate eligible work.

- Operations: test backup restore, account recovery, missed responses, intake outages, and project closure. Preserve protected obligations.

- Email: verify sender, service binding, recipients, quota, staging isolation, actual inbox receipt, bounce handling, retries, and escalation.

- Decisions: distinguish submission proof, technical validation, financial approval, and final payment evidence. A model verdict proves none of them.

- Disputes: name the payer and independent reviewer. State their powers, deadlines, nonresponse process, and binding or advisory authority.

- Release: verify desktop, mobile, keyboard, zoom, accessibility, links, network results, sanitized videos, and exact deployed revisions.

A program opens only after its policy, funding, access, notification, payment, and operational gates pass. Public-chain visibility requires reporter consent.

## 19. Open issue coverage

Reviewed 22 October 2026: all 18 open issues and their comments. This map records requirements and remaining evidence, not completion.

Issue comments can correct an older issue body. An open PR does not prove merge, deployment, or acceptance.

The technical requirement IDs and MVP package IDs remain stable inside this document.

| Issue | PRD scope | Remaining result |
| --- | --- | --- |
| [#640](https://github.com/SlopDotCash/slopdotcash/issues/640) | WAL; PRJ; UX; BOT; MVP-02/03/05a/10/11 | Complete the human workflows and installed-client checks. The reviewer accepted phone and zoom checks on emulation; no physical-device result exists. Use D1 admin approval, not the retired project-PR flow. |
| [#797](https://github.com/SlopDotCash/slopdotcash/issues/797) | SCR-04–06; ELG-02; MVP-09 | Evaluate retained review evidence under the existing rule. A maintainer decides disputed credit through evaluations. Publish a reasoned exclusion if rejected. Prevent duplicate awards. |
| [#898](https://github.com/SlopDotCash/slopdotcash/issues/898) | FND-02; PAY-08; MVP-06/11 | Base: complete independent audit first. The owner selects authorities and signs. Verify deployed code and record the factory. |
| [#899](https://github.com/SlopDotCash/slopdotcash/issues/899) | FND-02; TOK-01; MVP-07/11 | Robinhood Chain: prove testnet and test USDG supply. Complete audit before owner-signed deployment. Fee wallet is decided; authority and activation remain gated. |
| [#900](https://github.com/SlopDotCash/slopdotcash/issues/900) | FND-02; TOK-01; MVP-07b/11 | Ethereum: retain recorded USDC and fee-wallet decisions. Prove asset behavior and Sepolia acceptance. Complete audit before owner-signed deployment. |
| [#901](https://github.com/SlopDotCash/slopdotcash/issues/901) | PAY-08; MVP-06/11 | Solana: complete audit before upgrade. Verify exact program bytes. Remove the test-key authority through the approved governance procedure. |
| [#902](https://github.com/SlopDotCash/slopdotcash/issues/902) | TOK-05; PAY; MVP-07/07b | Record funded public-testnet transactions and reconciled totals on all four networks. Local forks do not satisfy this requirement. |
| [#903](https://github.com/SlopDotCash/slopdotcash/issues/903) | PAY-05; TOK-07; MVP-06/11 | Complete independent contract audit and resolve findings before mainnet deployment. Obtain counsel review of attester and fee-wallet authority. |
| [#904](https://github.com/SlopDotCash/slopdotcash/issues/904) | PAY-04/05; ARC-01; MVP-07 | Qualify managed attestation, finality endpoints, network configuration, and one authorized mainnet payout per network. Slop remains outside payment execution. |
| [#905](https://github.com/SlopDotCash/slopdotcash/issues/905) | TOK-07; MVP-07c | Verify custody, approved routes, limits, dry runs, and controlled activation. USDG is the Robinhood target. Only humans withdraw conversion proceeds. |
| [#906](https://github.com/SlopDotCash/slopdotcash/issues/906) | PRJ-01; NOT-01; MVP-03/10/11 | Prove an authorized application reaches every configured admin inbox. Deployment and provider acceptance do not prove receipt. |
| [#908](https://github.com/SlopDotCash/slopdotcash/issues/908) | PRJ-01/02; MVP-03 | Reconcile existing D1 entries before new applications. Avoid duplicates. Verify authority, terms, funding, skills, and security before activation. |
| [#909](https://github.com/SlopDotCash/slopdotcash/issues/909) | VET-01–08; MVP-12 | Complete execution, interception, monitoring, provider reviews, retention, and deployed clean/incomplete/malicious checks. Retained fixture bytes do not prove complete coverage. |
| [#910](https://github.com/SlopDotCash/slopdotcash/issues/910) | SEC-01–18; MVP-13 | Complete private 75/25 settlement and recovery, then the full staging matrix. PR #1011 source is integrated. Deployment and independent approval evidence remain separate. |
| [#911](https://github.com/SlopDotCash/slopdotcash/issues/911) | ADM-05/06; ELG-02; MVP-10 | Qualify authorized staging moderation, appeal, independent review, and a fresh complete scan. The staging configuration is merged; production authority remains separate. |
| [#912](https://github.com/SlopDotCash/slopdotcash/issues/912) | NOT-01; MVP-10 | Verify deployed inbox and email preferences, persistent consent, withdrawal, replay protection, actual delivery, and separate acknowledgment. |
| [#913](https://github.com/SlopDotCash/slopdotcash/issues/913) | MVP-11; completion record | Record every requirement, owner, exact revision, real workflow result, release result, and resolved blocker. Obtain maintainer approval. |
| [#914](https://github.com/SlopDotCash/slopdotcash/issues/914) | All MVP packages | Keep the completion tracker aligned with this PRD. Separate source, test, deployment, service, device, and payment evidence. |

## 20. Source and change control

The repository file docs/slop-product-requirements.md is the single authoritative PRD. Approve changes through repository review, then update the Google Docs mirror. If the copies differ, the repository governs.

Historical source revision: 0dca651873548aa9ba06636ceba154652604a26d. Historical details support implementation; current decisions in this PRD take precedence.

[Historical technical requirements](https://github.com/SlopDotCash/slopdotcash/blob/0dca651873548aa9ba06636ceba154652604a26d/docs/slop-product-requirements.md)

[Objective quality closure rules](https://github.com/SlopDotCash/slopdotcash/blob/0dca651873548aa9ba06636ceba154652604a26d/docs/slopbot-quality-closure-proposal.md)

The former delivery plan is consolidated here. Its package IDs, release gates, private-bounty checks, and completion requirements remain in force.

Record each change with the requirement ID, decision owner, approval, and effective date. Preserve historical obligations.

Owner clarification, 22 October 2026: private security bounties use a 25% slop.cash commission instead of the ordinary public 2% commission.

Language follows ASD-STE100 principles. Full dictionary conformity has not been certified.
