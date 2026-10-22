# Slop MVP Delivery Plan

Date: 6 October 2026. Project-token reward scope added: 13 October 2026; project-token fee settlement decided: 14 October 2026; simplification decisions recorded by the product owner: 18 October 2026. Status: MVP scope submitted for adoption alongside [Slop Product Requirements](slop-product-requirements.md).

## Scope

The MVP retains current product capabilities and completes account, project, contribution, review, discovery, funding, and payout journeys on Base and Solana, with Robinhood Chain and Ethereum as further escrow settlement networks (FND-02), and stablecoin or supported project-token rewards with any decimals on each network (TOK-01–07). The project vault contract is the only funding mode (FND-01); Squads v4, Sablier, legacy direct and committed instruments and the PAY-09 monthly-pool rail are removed, and their records stay in git history. Projects live only in the append-only D1 registry, and project skills are generated from the D1 revision with one canonical template (PRJ-02, SKL-03). Public pages serve cached D1 data (ARC-01). A new network or asset activates no project. It also requires optional participant-scoped Slopbot, Slop Score as the default leaderboard sort, issue/PR outcome metrics, closure penalties, admin featuring/bans, and mandatory community security vetting. Source availability is not proof of production readiness. Private security bounty programs are an MVP addition under SEC-01–18 and MVP-13; the repository owner approved this scope on 14 October 2026. Fee-wallet conversion of project-token fees (TOK-07, MVP-07c) is MVP scope from 18 October 2026. Other Robinhood integrations, bridges, swaps in a payment path, and additional chains are future work.

For ordinary payout obligations, the maintainer-approved fee is 2% deducted from the gross award: 100 USDC gross means 98 to the contributor and 2 fee. Reserve the 100 once, show net contributor earnings, and preserve recorded legacy terms. A withdrawal of unused free funds pays the same 2%, `floor(gross / 50)`, enforced in the contracts (repository owner decision, 19 October 2026, #907), and reaches only the owner's refund destination (FND-04, PRD section 18). The repository owner approved the PAY-05 actor-binding proof and recovery authority (the bounded identity attester) on 14 October 2026; execution authority remains a separate approval gate. Security bounties instead use the project-specific gross amount and the owner-approved 75/25 researcher/Slop split in SEC-05, without another ordinary payout fee.

For a project-token reward, the product owner decided on 14 October 2026 that the same 2% is deducted in the project token, rounded down once per award, and paid in that token directly to the network fee wallet at payout (TOK-06). No contract converts the fee. On 18 October 2026 the product owner moved fee-wallet conversion into the MVP: a scheduled backend job converts fees already in the fee wallet to the network stablecoin inside that wallet (TOK-07, MVP-07c). Slop holds one fee-wallet hot key per network for this job only, as a narrow exception; the key holds no vault role and never touches contributor payments.

## Implementation scope and phase exit

Implement only the approved work packages below. Every implementation issue and PR must reference the exact PRD requirement and MVP package. New proposals must review and reference the PRD, or add a proposed requirement for human approval before implementation. A future requirement, open issue, or agent recommendation does not expand MVP scope.

Only project owners and maintainers open issues, in this repository and on target projects (repository owner, 19 October 2026). Contributors work from existing issues and approved requirements through pull requests and never open issues; agents working for contributors must not open or submit issues by any path. The rule, its effective date and appeal path are in `CONTRIBUTING.md`. Every Slop participation PR includes `Made via @slopdotcash`.

The rest of the PRD is blocked until maintainers approve an explicit MVP completion record. That record must map every work package and requirement to exact revisions, test results, real workflow validation, release evidence, and resolved blocking defects. It must confirm the MVP is finished, verified, tested and validated. A partially shipped feature, green local suite, merged PR, or model declaration is not phase completion. After confirmation, humans approve the next PRD phase before implementation begins.

## Work packages

| ID | Requirements | Concrete result | Dependency and acceptance |
| --- | --- | --- | --- |
| MVP-00 | PRD sections 3, 4, 22 | Approved scope, financial terms, deposit rights, authority, policy migration | Resolve conflicts before implementation; maintainers approve PRD and this plan |
| MVP-01 | ACC-01–05, SOC-01–02 | One GitHub account with profile, optional X and Telegram connections, sessions, privacy and recovery | Reuse identity/membership; real OAuth, rename and access tests; Telegram bot webhook delivery against the exact head |
| MVP-02 | WAL-01–05 | Backend Base, Solana, Robinhood Chain and Ethereum wallet connections and safe changes | MVP-01; real wallet proof, unsupported paths, replay/concurrency and recovery |
| MVP-03 | PRJ-01–05, SKL-03, ADM-02, ADM-06, UX-10 | Resumable project setup and updates stored as append-only D1 revisions; admin approval at `/admin` publishes; no GitHub PR and no project JSON or per-project skill folder in the repository; contributor and reviewer skills generated from the D1 revision (scope, contribution guide, supported tasks, required tests, review expectations, security contact, closure policy, maintainer notes) with one canonical generic template; optional Slopbot settings/health | MVP-00/01 for drafts; MVP-12 before executable activation; actual permissions; deterministic generation (same template revision and D1 revision give the same bytes); stale-revision refusal; maintainer notes cannot weaken template rules |
| MVP-04 | SKL-01–07 | Discovery/project skills, owner-and-maintainer-only issues, visible attribution and sandbox checks | MVP-03/12; genuine contribution; installer trust root (template revision on `main`, D1 revision digest) with mismatch refusal; exact approved-revision execution |
| MVP-05 | BOT-01–07 | Optional Slopbot, marker/member routing, external opt-in, ignored actors, guideline-aware review and delegated closures | MVP-03/04/12; full eligibility matrix, health, stale revision, close confirmation, retry and uninstall |
| MVP-05a | BOT-08–13 | Hosted `workers/slopbot` GitHub App: active registered repositories only (owner decision, 21 October 2026), Protection mode, model route, cost ledger, shadow mode, closure confirmation, appeals, prepaid credits and owner-requested $500 monthly API cost milestone emails | Approved 9 October 2026 (`docs/slopbot-v2-proposal.md`); registered App and provider keys; real PR/issue review, close, appeal, budget exhaustion, uninstall and invoice reconciliation on `SlopDotCash/slopdotcash` first |
| MVP-05b | PAY-10, FND-06 | `charge_service` in both escrow programs and service allocation | Delivered inside MVP-06 contract review; conservation and exactly-once evidence |
| MVP-06 | FND-01–05, PAY-01–08, TOK-03 | EVM (Base, Robinhood Chain, Ethereum) contract and Solana program as the only funding mode: permissionless deposits into one bucket, no donor class, free funds refundable only to the owner's refund destination, 2% withdrawal fee `floor(gross / 50)`, equal to the payout fee, enforced in the contracts, any-decimals asset support, protected obligations | MVP-00/02/03; approved PAY-05 actor-binding proof and recovery authority, independent review and accounting/authority conformance; conservation tests at decimals 0, 6, 9 and 18 |
| MVP-07 | PAY-01–08 | Human approval, manual/automatic execution, late wallet dispatch, finality and receipts | MVP-06; full same-scenario test deployment evidence on Base, Solana and Robinhood Chain (Paxos test USDG on chain id 46630) |
| MVP-07a | PAY-09 (removed) | Retired 18 October 2026. The monthly-pool settlement network package (RFC #472) is removed with Squads, Sablier and the legacy rail; its records stay in git history | No further work; the published fee addresses stay on record in PRD PAY-09 |
| MVP-07b | TOK-01–06, FND-02/05, WAL-01/02, PAY-06, LDR-03 | Project-token rewards on Base, Solana, Robinhood Chain and Ethereum: one asset per project (any standard ERC-20 or classic SPL token; fee-on-transfer, rebasing and Token-2022 rejected), exact integer accounting in base units, any-decimals support in the escrow contract, program and adapter, reward filters, 2% fee paid in the project token to the network fee wallet, and verified receipts | Scope approved 13 October 2026, fee decided 14 October 2026 and scope widened 18 October 2026 by the product owner; reuse MVP-02/03/06/07/09/10. Real complete workflows on every test network, assets with decimals other than six (0, 9 and 18), rejection of a fee-on-transfer token, and unchanged historical USDC records are required. Circle USDC on Ethereum is verified from Circle's primary source before activation |
| MVP-07c | TOK-07, PAY-04, PRD section 17 security | Scheduled backend job per network that converts project-token fees already in the fee wallet to the network stablecoin inside that wallet: one Slop-held fee-wallet hot key per network with no vault role; allowlisted routes; reviewed slippage limit as a minimum output; reviewed minimum conversion size; exact-amount approvals; output only to the fee wallet; append-only proceeds records; dry run by default | MVP-07b. Never blocks, delays or changes a contributor payment and never touches a vault. Humans create and hold the key. Signing on a network needs a reviewed activation record; Solana stays blocked until the fee-recipient rotation role is kept apart from the hot key. Testnet evidence: dry run, signed conversion, slippage refusal, below-minimum skip, unsupported route, payments unchanged during a conversion failure |
| MVP-08 | ELG-01–03 | Prospective maintainer exclusions, moderation, financial holds and appeals | MVP-00/03/07; scoped human decisions and protected accrued obligations |
| MVP-09 | SCR-01–06, LDR-01–03, DSC-01–04 | Separate signed Slop Score/points, shared commit-author merge credit (owner decision on #506), outcome-first merge and review credit, automatic provisional value assessment and September/October back-valuation under SCR-06, closure debits/reversals, issue/PR ratios and score-default sorting | MVP-00/03/05/07/08; exact source coverage, ties, zero denominators, no duplicate penalties or financial seizure |
| MVP-09a | LDR-04 | Slopbot Automation row | MVP-05a cost ledger; never ranked with people |
| MVP-10 | ADM-01–06, NOT-01, UX-01–17, ARC-01, PRD sections 16–17 | Unified pages, bot health, security evidence, admin featuring/bans, notifications and recovery; public pages served from cached D1 data and snapshots, vault totals from finalized counters with observed time | Relevant prior packages; permissions, D1 revision enforcement, cached/direct-route enforcement, no live chain or GitHub read per public page view, stale labels, appeals and browser evidence |
| MVP-12 | VET-01–08 | Revision-bound secure-VM vetting, full declared telemetry, binary/obfuscation quarantine, Astra and Opus reviews, confirmed-malware bans | MVP-00/01 and project drafts; required before community/featured executable onboarding; isolated clean/malicious fixture evidence |
| MVP-13 | SEC-01–18 | Private loss-of-funds bounty programs with configurable gross amount, 75/25 split, human eligibility decisions, appeals, safe remediation and private payment records | MVP-00/01/03 and scoped identity/notification/financial reuse; the matrix below and program-specific launch gates must pass; no inherited public cycle export |
| MVP-11 | DEP-01, PRD sections 20–23 | Versioned migration and limited production activation | All release gates; authorized production proof and reconciliation |

No package is marked implemented by this document. Create bounded implementation issues only after approval, tied to a real missing requirement and existing work. Reuse or reconcile open vault, settlement, installer, queue and deployment proposals before starting duplicate work.

## Vertical slices

1. A contributor signs in, connects X optionally, adds a verified wallet on each supported network, and sees correct private/public state.
2. A maintainer proves repository authority, passes security admission, submits the project revision, an admin approves it at `/admin`, Slop generates both skills from that revision, and the maintainer optionally configures Slopbot. Tagged/member submissions are reviewed; external/ignored submissions are skipped unless explicitly configured otherwise.
3. A contributor discovers cleared work through the main skill, uses the approved community sandbox, completes required tests, and submits a tagged PR. Contributors do not open issues.
4. The owner funds a vault and a third party deposits into the same bucket; the deposit flow shows the refund rule before signature; the maintainer approves awards for registered and walletless actors.
5. Registered actors receive exact payments; late registration triggers the remaining funded award; retries do not repay; a withdrawal of free funds pays 2% and reaches only the owner's refund destination.
6. Slopbot closes an eligible policy-violating issue/PR under delegated rules. Confirm one points/score debit, ratios, retry deduplication, and reversal after reopen/appeal; preserve earned obligations.
7. An admin promotes a cleared community project, bans a project, and verifies that discovery/skill routes stop serving it. A confirmed malicious scan also invokes the recorded ban policy. Reinstatement requires independent review and a new scan.
8. A researcher privately reports a critical defect using safe local evidence. A maintainer confirms potential loss, reserves the configured gross bounty, handles an appeal if needed, and verifies the researcher and Slop shares. Retest and disclosure remain separate.
9. A human handles an exclusion, wallet incident, and appeal without erasing history; the site defaults to Slop Score and can sort by Points or Money received.
10. A maintainer selects a supported project token and network. A contributor filters token-reward projects, reads the token-denominated terms, and receives a verified award through the same journey: 98% of the gross in the token to the contributor and 2% in the token to the fee wallet. Repeat funding, approval, late wallet registration, execution, reconciliation and duplicate-retry checks on each network. Verify assets with decimals other than six and clear unsupported, fee-on-transfer or frozen-asset states. Legacy USDC cycles do not change.
11. The fee wallet receives a project-token fee. The MVP-07c job runs in dry run and records the intended conversion; with signing enabled on a test network it converts through an allowlisted route within the slippage limit and records the proceeds. A conversion failure leaves every contributor payment unchanged.
12. Public pages show projects, vault totals and leaderboards with chain and GitHub providers unavailable, from cached D1 data with observed times and stale labels.

## Release gates

- **Policy:** section 22 decisions approved, effective dates set, and all affected instructions/protocols agree. Keep `AGENTS.md` and `CLAUDE.md` identical when they are updated.
- **Source:** scoped current-base branch, pinned dependencies, required repository checks, exact-head review, and real workflow evidence.
- **Identity:** live GitHub and X configuration independently qualified; optional X failure does not block contribution or payment.
- **Bot scope and penalties:** optional/off/incomplete/ready/degraded states, tagged nonmember, untagged member, unknown membership, external opt-in, ignored maintainer/contributor, stale revision, manual versus bot closure, failed close, merge, reopen and appeal; each has its specified review and journal outcome.
- **Community security:** isolated VM, trusted outside collector, file/disk/process/network telemetry, canary probes, controlled egress, tamper detection, recursive artifact quarantine, independent pinned Astra/Opus scans, incomplete/clean/malicious dispositions, no unscanned execution, and revision revocation.
- **Contracts:** exact deployed code, network/asset/vault identity, permissions, reserve invariants, one deposit bucket, withdrawal only to the owner's refund destination, 2% payout fee arithmetic `floor(gross / 50)`, 2% withdrawal fee arithmetic `floor(gross / 50)`, any-decimals conservation, no Slop-held key able to originate or redirect a payment, and independent security review. Humans deploy mainnet contracts; agents never do.
- **Financial operations:** complete Base, Solana, Robinhood Chain and Ethereum test scenarios for stablecoin and supported project-token rewards, ambiguous-send recovery, replay protection, finalized receipts, queue/indexer restart and reconciliation.
- **Project tokens:** TOK-01–06 and MVP-07b evidence; the 2% fee arrives in the project token at the approved fee wallet of each network; no contract or adapter converts it; chain and asset identity, non-six-decimal conservation, unsupported/fee-on-transfer/frozen-asset handling, wrong-chain/asset rejection, separate per-asset totals and unchanged historical USDC receipts. Fee wallets per network are decided (19 October 2026). Open activation gates: Circle USDC identity on Ethereum, supported token behavior per token, and network finality. No further EVM chain is implied.
- **Fee conversion:** MVP-07c evidence on each test network; the job runs in dry run by default and signs on a network only after a reviewed activation record; the hot key holds no vault role and humans hold it; allowlist, slippage, minimum size and proceeds records verified; contributor payments unchanged when conversion fails.
- **Cached reads:** ARC-01; no public page view makes a live chain or GitHub request; vault totals come from finalized counters cached in D1 with observed time; stale and failed refreshes are labeled.
- **UI:** desktop/mobile, keyboard, 200% zoom, WCAG AA, copy/download/link checks, console/network evidence, uploaded walkthrough and test videos.
- **Deployment:** DEP-01 separates `development` staging and `main` production, including an isolated staging login and write backend; approved protected workflow and environment; production website/API/contract checks are separate. Claim the deploy/DNS lever before any such change.
- **Operations:** named incident/recovery owners, tested restore, scoped operator access, alerts, support/appeals and approved privacy/retention terms.
- **Private bounties:** MVP-13 complete; approved scope and safe harbor, verified intake and escalation, isolated permissions, fixed versioned financial terms, capacity/exhaustion policy, independent appeals, verified funds and payment rail, no case leakage, private exact-head remediation evidence and no inferred activation.
- **Pilot:** small authorized mainnet exposure; no broad enabling until actual payments and public totals reconcile.

## Issue #683 payment cutoff correction

MVP-07 and MVP-09 implement the owner's 14 October 2026 decision in the
SCR-05 payment cutoff amendment. Reuse the existing eligibility and allocation
code with the production-release cutoff for payment weights only. Keep public
Score and Points unchanged. Verify pre-release approval eligibility,
post-release exclusions, exact cutoff behavior, duplicate protection, frozen
source reconstruction and refusal of missing payment evidence. Funding and
settlement authorization remain separate gates.

## Future backlog

Private report auto-submission, native Slop-hosted exploit attachments and additional intake-provider adapters remain future extensions. MVP-13 uses human-submitted GitHub private advisories with restricted Slop policy/decision/payment records. No future automation lets contributors open public issues.

Robinhood Chain escrow settlement is MVP scope, approved by the repository owner on 14 October 2026 (FND-02, `docs/robinhood-chain-escrow-design.md`); other Robinhood integrations are defined separately. Ethereum escrow settlement and project-token rewards are MVP scope under TOK-01–06 and MVP-07b; fee-wallet conversion is MVP scope under TOK-07 and MVP-07c. Additional chain adapters require a funded use case and the same authority/accounting/finality acceptance as the MVP chains.

Merkle batching and additional wallet types should follow measured need and supported proof paths.

## Approval and MVP completion record

The maintainer-approved merge adopting this PRD and plan records scope approval. Record its PR/revision and the choices adopted from PRD section 22; unresolved choices remain implementation gates. Adoption does not activate bot closure, penalties, project bans, money movement, or a future phase without the corresponding reviewed implementation and policy activation.

**MVP completion: not confirmed. Future implementation: blocked.** The later completion record must identify the responsible maintainers, approval date and decision link; every MVP package/requirement; exact tested/deployed revisions; end-to-end, security, provider and chain evidence; resolved defects; and the approved next phase. Add the real record only after these conditions hold. Do not prefill completion, waive missing evidence silently, or infer completion from this document merge.

## Quality review delivery

The [PRD quality requirements](slop-product-requirements.md#quality-review-requirements) and
[dated full review](slop-quality-review.md) belong to MVP-10. This plan does not mark them implemented.
Reuse MVP-01/02 for account and wallet changes, MVP-03 for project forms, MVP-07 for payouts, and MVP-09 for rankings.
Retain Slop Score as the default. Keep financial-policy decisions in PRD section 22.

| Pass | Requirement IDs | Required result |
| --- | --- | --- |
| 1. Correct misleading displays | UX-02–05, UX-12, UX-14–15 | Accurate amount/state labels, readable mobile model data, formatted scores and explicit loading states |
| 2. Combine duplicate workflows | UX-01, UX-03–07, UX-10–11 | One account area, consistent rankings, shared people discovery, one profile summary and shared proposal/payout controls |
| 3. Reduce explanations | UX-08–09, UX-13, UX-16 | Shorter pages, canonical explanations, searchable evidence and preserved material conditions |
| 4. Show useful visuals | UX-05, UX-08–09, UX-11–12 | Readable process, payment stages, allocation/fee arithmetic, model coverage and funding readiness |
| 5. Verify quality | UX-17 and all affected requirements | Real browser workflows, before/after measures, uploaded walkthrough and evidence video, accessibility and recovery results |

Reproduce the dated defects first. Link existing fixes and omit work already complete.
Track every page and project-state variant from the review. Record any omitted suggestion and its requirement-based reason.
Do not use arbitrary copy quotas, decorative charts, extra tests or new abstractions as completion criteria.
Use the same inputs and states for before/after comparisons. Keep hashes, financial precision, consent and historical records available.
Documentation-only updates require link and consistency checks. Application E2E and UI videos apply to later implementation changes.

## Value-scoring delivery

Owner-approved on 9 October 2026 for #618: [Value-based contribution scoring](slop-value-scoring-plan.md) supplies the MVP-09/MVP-05a implementation and acceptance checklist. Automatic provisional scores are authorized; payout approval remains human. This package is not complete until all-project historical coverage and the installed Eliza bot are verified.

## MVP-13 delivery and acceptance

Scope updated 13 October 2026 and approved by the repository owner on 14 October 2026, including the 75/25 researcher/Slop split and the $10,000 gross Umia commitment. The PRD is the policy authority; [design research](private-bounty-design-review.md) explains the source evidence and alternatives. This package is required MVP scope, not a claim of implementation or authority to activate a project or move money.

Deliver in dependency order:

1. Adopt program terms and resolve SEC-01–06/15 launch decisions. Extend canonical registry-backed project setup with bounty-only and separate reward modes. Preserve existing projects and historical terms.
2. Add public terms and verified private-intake handoff. Add restricted case metadata, case membership and minimal notifications. Reuse account identity; separate public ingestion credentials and prevent all case exports.
3. Add human triage, evidence references, duplicate/appeal decisions and separate remediation/award/disclosure state. Qualify private reproduction and exact-head fix review without relying on public CI.
4. Add gross funding capacity, exact 75/25 reservation and private settlement evidence. Reuse the existing rails and finality rules under the owner’s 22 October 2026 private bounty payment decision in the PRD. Keep private ledgers and vault counters separate from ordinary payments. Keep the case available without a wallet.
5. Complete the matrix below on isolated staging and an authorized GitHub test repository. Use synthetic security examples. Record private evidence privately and provide only sanitized walkthroughs in public PRs. Qualify each real program’s authorized intake and actual funding separately before opening it. Umia is an example, not an implementation dependency.

| Scenario | Required outcome and evidence |
| --- | --- |
| Program setup and migration | Two projects have different gross amounts and sponsors; bounty-only setup needs no monthly pool; canonical immutable revisions and generated public terms agree; no hardcoded Umia activation |
| Amounts and public copy | $10,000 gross yields $7,500/$2,500; $100,000 yields $75,000/$25,000; reject inexact minor-unit splits; no extra ordinary fee; cards, skills, approval and receipts agree |
| Intake readiness | Enabled GitHub private reporting succeeds; disabled, stale, forbidden and unavailable states block unsafe handoff; verified emergency contact remains private; no public fallback |
| Direct and interrupted submission | Nonmember can report on GitHub and link later; local draft is not submitted; expired login preserves a safe return path; ambiguous result is reconciled before retry; original receipt/policy survives |
| Eligibility truth table | Critical plus proven potential loss qualifies with no real loss; critical without loss, noncritical loss concerns and nonsensitive accepted work do not auto-earn; uncertain cases remain private and appealable |
| Evidence and remediation | Authorized reviewer safely reproduces the funds-loss mechanism at the exact source/fork state; private patch review and independent tests pass; deployed mitigation is separately verified; no secret-bearing public PR/video/log |
| Identity and access | Reporter A cannot read reporter B; project A cannot read project B; sponsor/ordinary admin/Slopbot/public ingester lack exploit access; role loss, transfer, logout and revoked sessions revoke access; GitHub platform access limits are disclosed |
| Duplicates and conflicts | Same root cause cannot reserve twice across reports/patches; simultaneous reports follow approved terms; another person's evidence stays private; conflicted reviewers cannot decide appeals; corrections preserve history |
| Funding exhaustion | Pledge is not balance; concurrent reservations respect capacity; valid pending claims follow published exhaustion terms; pause leaves emergency intake and obligations intact; no double use of monthly reserves or vault deposits |
| Umia funding accounting | Verify Slop's actual funding separately from its commitment; reserve $10,000 gross; pay $7,500 net under the approved rail; account for retained $2,500 without a fake self-transfer or external revenue |
| Settlement recovery | Walletless, changed destination, partial payment, wrong asset/network/payee, ambiguous transfer, provider reversal, queue restart and repeated dispatch stay distinct; finalized evidence reconciles once; no manual paid toggle |
| No public leaks | Inspect unauthenticated/authenticated wrong-role APIs, built assets, caches, logs, email, analytics, leaderboard/points/model rankings, cycles, downloads and notifications; no case content, identifiers, hashes, counts or inferable deltas |
| Disclosure | Paid does not publish; fixed does not publish; deadline does not publish; authorized redaction and optional identity consent are independent; chain timing/amount visibility is disclosed before payment |
| Ordinary-work compatibility | Umia accepts other useful work without bounty; no cash via later fix PR or public recognition; other projects retain separate approved ordinary rewards without double payment |
| Operations and closure | Test notification failure, missed response escalation, intake outage, backup restore, project ban/closure and account recovery; restrict access but preserve obligations; no public penalty for a private case disposition |
| Cloudflare email readiness | Owning account/domain, authenticated sender, Worker and private service binding, audience permissions and quota are verified; controlled end-to-end send reaches maintainer/reporter inboxes; bounce/suppression/retry and staging isolation work; acceptance/delivery/human acknowledgment stay distinct |
| Submission and decision proof | Bind policy and evidence version to a private receipt; reject forged case links; reproduce the loss mechanism; record human technical and financial decisions separately; edited evidence cannot silently change an approved award |
| Maintainer trust and dispute | Named payer and independent reviewer; advisory/binding authority disclosed; disagreement, nonresponse and alleged duplicate each follow private deadlines and appeals; no model verdict or timeout releases funds; Umia/Slop authority split agreed before launch |
| Real UI and release | Desktop/mobile, keyboard, 200% zoom, WCAG AA, safe links, zero first-party failures and application console errors; uploaded sanitized walkthrough and test video; exact tested/deployed revision and authorized pilot evidence |

The launch record must name security, finance, privacy and incident owners; exact program and code revisions; approved deadlines and economic edge policies; permission/notification results; funding evidence; tested payment rail; and unresolved limits. A source merge, synthetic scenario or private-reporting enablement alone cannot establish production bounty readiness. No program is opened by this documentation change.

Slopbot scope acceptance (MVP-05a): compare selected App repositories with live D1.
Prove that unregistered, paused, retired and restricted repositories cannot queue
reviews, consume stale jobs, call a model or receive GitHub writes. Prove that
registered public repositories still reach the review queue. Fail closed on a
registry outage. Installation and local checks do not prove production delivery.

The [objective quality closure amendment](slopbot-quality-closure-proposal.md)
is approved for MVP-05a implementation (owner decision, 21 October 2026).
Acceptance requires trusted evidence for the three defined defects, two grounded
verdicts for the same defect, useful counterexamples, and the existing appeal,
source-change and shadow controls. Production activation is not approved.


## Open-issue close-out plan — 22 October 2026

This is a delivery plan under the owner's delegated implementation judgment,
not the completion record required by #913. The [PRD close-out direction](slop-product-requirements.md#22-october-2026-mvp-close-out-direction)
records the selected pilot identities and unchanged authority boundaries.
The source baseline reviewed here is development
`fc11230ea9c4a981c9cabeb0b51de29786c51d5e`.

| Issues | Package | Remaining result and acceptance boundary |
| --- | --- | --- |
| #898, #899, #900, #901 | MVP-06/11 | Wait for #903, then human-signed mainnet deployment or upgrade. Verify exact deployed bytes, network, asset and authority independently. |
| #902 | MVP-07/07b | Run the existing acceptance runner on all four approved test networks with funded test accounts and exact deployments. Reconcile the 2% payout and withdrawal fees, walletless dispatch, replay and cached balances. Local-chain evidence does not close this item. |
| #903 | MVP-06/07c | Obtain the independent contract audit and counsel reviews. Resolve findings against exact code. An internal agent review cannot replace these reviews. |
| #904 | MVP-07/11 | Qualify managed attestation and finalized reads after audit and testnet acceptance. Enable each network separately and reconcile an authorized payment. |
| #905 | MVP-07c | Fee-wallet addresses are decided. Custody, allowed routes, slippage, minimum size, target asset and Solana role separation still need the reviewed activation record. Keep signing off before acceptance. |
| #906 | MVP-03/10/11 | Worker source and Pages binding are merged. Verify the deployed binding, a real application notice, provider acceptance and receipt in each authorized inbox separately. |
| #908 | MVP-03/04/12 | Read the live D1 registry. The old zero-project report is stale: the public registry returned 11 projects on 22 October. Existing rows are not proof of clean vetting, executable skill publication or payment readiness. Do not submit duplicate applications. |
| #909 | MVP-12 | Complete command execution, structured telemetry and loss detection, runtime network inspection, filesystem differences and pre-execution artifact interception. Scanner transports (#953) and publication (#955) are merged, but real independent provider and complete runtime acceptance remain. Qualify incomplete, clean and malicious outcomes without weakening admission. |
| #910 | MVP-13 | Separate owner workstream, excluded from this implementation sweep. Its full approved acceptance matrix still blocks final MVP completion. |
| #911 | MVP-10/12 | Use the selected staging moderators. Prove ban, appeal and independent reinstatement, with fresh complete vetting and preserved obligations. #909 remains a dependency; configuring identities cannot close it. |
| #912 | MVP-10 | Inbox and verified-email source are merged. Complete deployed preference, delivery and inbox receipt checks; preserve replay deduplication and distinct delivery states. |
| #797 | MVP-09 | Keep existing accepted attribution. Resolve competing preserved review evidence through a separate decision before any evaluations award. No automatic score change. |
| #640 | MVP-02/03/10/11 | Complete the named human, wallet-consent, installed-client and physical-device checks. Reuse verified repairs. Do not replace these checks with browser fixtures. |
| #913, #914 | All | Assemble exact source, check, staging, production, provider and chain evidence. Close the tracker only after its dependencies pass and maintainers approve the completion record. |

First restore the existing release validation path. Production run
[39819905467](https://github.com/SlopDotCash/slopdotcash/actions/runs/39819905467)
failed before browser tests because a timed-out privileged package installer kept
its lock. #1006 fixes cleanup on development. Development runs
[39804797146](https://github.com/SlopDotCash/slopdotcash/actions/runs/39804797146)
and [39819912288](https://github.com/SlopDotCash/slopdotcash/actions/runs/39819912288)
still exceeded the ten-minute dependency-download deadline. PR run
[39847362140](https://github.com/SlopDotCash/slopdotcash/actions/runs/39847362140)
also exceeded twenty minutes while the Azure package mirror stalled. Use the
primary Ubuntu archive with the existing signing keys, suites and components.
Retain the bounded installation window, privileged cleanup and no package retry.
Require successful exact-head browser lanes and staging acceptance before
promotion. Do not treat a previous production deployment as evidence for newer
source.

For every row, retain the exact revision, environment, command or user action,
actual result and evidence link. Mark missing evidence explicitly. Record source
completion separately from deployment and external acceptance. Do not close an
issue by moving its unresolved checks into the completion record.
