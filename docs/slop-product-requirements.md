# Slop Product Requirements

Product requirements • 22 October 2026

Make money shipping and securing open source.

Slop connects useful open-source contributions and private security reports to human review and verified rewards. GitHub is where work is submitted and accepted. Slop records policy, decisions, and payment evidence.

This repository PRD is canonical. The [Google Docs mirror](https://docs.google.com/document/d/1on3Ge018mShloCpxVMs62ZCA81YA1U3HUv2s-VV7cWo/edit) provides a formatted copy. It includes product requirements, MVP delivery, acceptance, open decisions, and issue coverage.

This edition does not establish implementation, release, or payment approval. Unresolved decisions remain open.

## 1. Product and scope

The minimum viable product (MVP) supports two journeys: contribute useful work, or report a vulnerability privately. Both end with a human decision and verified payment when eligible. Security clearance protects both.

Contributors use any disclosed agent/model or work manually. Maintainers define scope and accept outcomes. Researchers report privately. Funders review terms before depositing. Operators manage admission, access, incidents, and appeals.

Scope: accounts, wallets, projects, generated skills, Slopbot, security checks, rankings, vaults, private bounties, and fee-wallet conversion. Networks: Base, Solana, Robinhood Chain, and Ethereum, using approved stablecoins or supported project tokens.

Future: more networks, bridges, token creation, brokerage, wallet types, and automatic private-report submission. Contributor-payment swaps remain excluded.

Measure accepted work, validated reports, verified fixes, eligible payments, delays, missed notices, and reconciliation errors. Private-case measures remain restricted.

Only owners and maintainers open issues (19 October decision). Contributors use approved requirements or existing issues. An issue does not approve scope. Maintainers approve PRD changes; the next phase requires an approved MVP completion record.

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

GitHub is the only login. Use its permanent actor ID through renames. Account holds profile, connections, wallets, preferences, and sessions, with links to Inbox and Payouts. Payouts uses the same wallet controls. Social connections are optional; wallets are required only for payment.

Directory membership is private until opted in. Public GitHub work stays public. X connection permits no posting or messaging. Keep web, contributor-client, and operator access separate. Support session revocation, private recovery, and account closure.

SOC-02: link Telegram from an authenticated account with a single-use bot code, valid for ten minutes. Only a private `/start` message received through the authenticated webhook proves the numeric Telegram ID. Reply only there. Load no Telegram scripts/frames; request no phone number or password.

Store only ID, optional username, verification time, and visibility. Reserve that ID to the first verified GitHub identity, including after disconnect. Public display requires membership and link consent. Grant no points or authority. Telegram failure cannot block work/payments; group gating and community replies are excluded.

Wallet changes require fresh account proof, the exact network/destination signature, and consent. Never request seeds. Keep one active destination per network and permanent history. Freeze it during payment; reconcile uncertainty before retry. Accept work and reserve funded awards before wallet setup. Redirected recovery needs two authorized operators; the proposed 24-hour delay remains undecided.

## 4. Projects and contribution skills

PRJ-01–05; SKL-01–07

Setup has four steps: Repository, Contribution rules, Rewards, Review. Funding terms belong in Rewards. Save draft and step without credentials. Preview the page and both skills; show application status.

Verify repository authority and license facts. Admin approval creates a paused project. Updates show a diff and reason, bind the saved base revision, and return to admin review. Reject stale or repeated approvals. Activation requires approved policy, reviewed skills, clearance, funding, and authority.

Generate each skill from its single template and approved D1 revision; retain no project copies. Bind template revision on `main`, D1 digest, and exact bytes. Support discovery outside a checkout and known-repository work. Recheck live GitHub at selection and submission. Respect assignments, reviews, drafts, claims, and security restrictions. Do not invent work for points.

PRs explain the problem, requirement, result, implementation choice, and real evidence. Include `Made via @slopdotcash`, signed attribution, and exact provider/model/client. Follow the effective trace policy; contributors inspect/redact permitted private uploads. Usage totals never set rewards. Economic changes are prospective; preserve funded awards.

PRJ-05: show the optional `?ref=<github-login>` referrer and allow removal. Resolve the live Slop identity at submission. Fix its actor ID and login on the application and approved project for life. Reject self, steward, admin, and moderator referrals with a reason. Attribution grants no points or payment; a paid program needs separate scope, legal review, and funding.

## 5. Slopbot

BOT-01–13; LDR-04

Slopbot is optional. Show actual readiness and the next action. The 21 October decision permits only public repositories of active D1 projects; protection-only installations are superseded. Recheck scope before queueing, calls, and writes. Registry failure or revoked authority stops work.

Funded projects default to participants-only review: a visible marker or registered actor. External review needs opt-in. Apply security, scope, and ignore rules first. Separate review exemptions from payout exclusions; unknown membership cannot authorize closure.

Review exact source against approved base-branch rules. Run untrusted code only in approved isolation, without secrets or posting credentials. Report tests not run. The recorded route is Surplus Opus 5.5, then GPT-6.1 Sol fallback. Disclose route and unverified served-model identity; independent confirmation remains a decision gate.

Charge metered cost plus 10%, with prepayment and hard budgets. Exclude failed calls and Slop-caused retries. Offset the monthly invoice with that month's payout fees. Only owners authorize charges to free vault funds. Retain costs, reconcile invoices, and send each $500 monthly cost alert once.

Closure requires explicit settings, grounded evidence, independent confirmation, unchanged source, and appeal. Qualify both 14 days and 50 shadow reviews. Default limit: 25 closures/repository/day. More than 10% reopening within seven days returns to label-only mode. A maintainer reopen protects that revision.

Only removed required behavior, reproduced workflow regression, or demonstrably false evidence qualifies for objective quality closure. Missing tests alone do not. Production approval cannot precede 1 November 2026, 00:00 UTC. Slopbot cannot merge, approve awards, or ban people. Closure never establishes a financial penalty.

## 6. Funds and payments

FND-01–06; PAY-01–10; TOK-01–07

Use one project vault, network, reward asset, and deposit balance. Anyone may deposit; only the owner withdraws free funds to the recorded refund destination. Explain this before signature. Depositors gain no separate refund right. Reserved awards and fees cannot be withdrawn. Retired funding modes remain historical.

Support the approved stablecoin, ERC-20, or classic SPL token. Exclude transfer-fee, rebasing, and Token-2022 tokens. Verify identity, decimals, behavior, and finality. Freeze asset/network while obligations exist. Use integer base units; never add unlike assets or present tokens as dollars.

Awards: projected, under review, approved, excluded. Payments: underfunded, awaiting wallet, ready, held, submitted, paid. A failed attempt preserves the award and reserve; one recipient's failure cannot block others.

Monthly allocations need complete sources, fixed caps, integer allocation, 14-day review, and zero-award records. Rollover cannot raise caps. Humans approve amounts; reserve gross once. Automatic execution applies only to approved funded obligations.

Ordinary award and free-fund withdrawal fee: `floor(gross / 50)` (2%). A 100 USDC award pays 98 and 2. Project-token awards pay both amounts in that token. No second fee at claim/retry. Preserve historical terms. Private bounties instead use section 8's 75/25 split.

A project-operated or permissionless executor submits payments; Slop operates no payment key/relayer. Wallet binding requires authenticated account evidence and the wallet signature, delayed activation, cancellation, and controlled key replacement. Neither signature proves both identities. Mark paid only after exact finalized principal, fee, asset, and destination reconciliation; prevent replay.

Convert fees only after they reach the fee wallet. Begin in dry-run. Signing needs approved routes, slippage, minimums, and network activation. The key has no vault role; output returns to the same fee wallet. Humans manage keys and withdraw proceeds. Attester and fee-wallet keys are approved design exceptions, subject to section 9's remaining gates.

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

SCR-06 assessments explain alignment, impact, complexity, evidence, maintenance, and overlap. Use the approved value bands (integer thirds): micro 1, small 3, medium 9, large 24, XL 45, exceptional 75. Distinct evidenced review bands are triage 1, standard 3, deep 9, specialist 24. Useful validation can qualify through this assessment without a request for changes. Do not double-credit an outcome or replace the ordinary ledger rule silently. Missing evidence stays unresolved. Bind each decision and correction to exact source, rubric, model, and predecessor; preserve credit across stacked or indirect merges.

Make Featured and Community projects easy to find. Show real funding, suitable work, and freshness. Featuring does not guarantee payment.

Use one account area, one shared ranking view, and one status summary per project. Show the result, the next action, and any restriction together. Put optional explanations after the action. Keep required consent, amounts, and evidence visible.

Preserve public links, downloads, exact amounts, and evidence details. Use the existing design tokens.

Support mobile, keyboard access, screen readers, reduced motion, and 200% zoom. Meet WCAG AA accessibility requirements.

Keep loading, empty, stale, invalid, denied, unavailable, and failed states distinct. Each failure needs a useful next action.

### User journeys

Use the existing routes and shared controls. These are acceptance requirements, not claims that every live service is ready.

| Person and goal | Shortest complete flow | Required outcome or recovery |
| --- | --- | --- |
| Contributor | Home → project → eligible work → skill → GitHub PR → Payouts | Clear scope, safe execution, accepted outcome, award reason, and verified payment; wallet setup uses Account |
| Researcher | Project security terms → private GitHub report → Security cases → decision → payment | Visible net award and privacy terms; confirmed receipt; next action and deadline; private appeal; no public fallback |
| Maintainer | Add project → four setup steps → admin review → clearance → activation | Resume draft, preview page/skills, see application status; updates use the same review path |
| Funder or owner | Project funding → terms and balance → deposit, approve, or withdraw → receipt | Separate available and reserved funds; show asset, gross, fee, net, signer, and finality; reconcile an uncertain send before retry |
| Member | GitHub login → Account → connections, wallets, sessions → Inbox/Payouts | Preserve return destination and drafts; independent consent; revoke sessions; private recovery and account closure |
| Moderator | Admin → exact application or restriction → evidence → decision or appeal | Current authority, saved reason, independent reinstatement, fresh scan; preserve awards |
| Security operator | Private vetting evidence → authorized reasoned grant → inspect → record result | Exact retained bytes, explicit coverage gaps, audited access; no clean result from incomplete evidence |
| Visitor | Projects, profiles, shared rankings, models/clients, receipts, cycles, sponsors, How it works | Consistent amounts and periods; explain score, funding, and verification once; retain old URLs and raw downloads |

UX-01–17 covers this inventory, including legacy points/wallet/verification links and unknown routes. Show a useful next action for loading, empty, stale, invalid, denied, unavailable, and failed states. A link, copied request, saved draft, provider acceptance, or submitted transaction is not completion.

## 8. Security and private bounties

VET-01–08; ADM-01–06; SEC-01–18

### Clear a project before execution

Clearance binds the exact source, dependencies, skills, and artifacts. Featured status grants no exception. Use a disposable isolated virtual machine. Block real credentials, host access, and unapproved network traffic. Quarantine generated, downloaded, and hidden executable content before execution.

Retain exact process, file, and network evidence with its gaps. Compare source and release bytes where required. Missing events, unsupported execution, or incomplete observation cannot become a clean result. Equal bytes alone do not prove safety. Require independent Astra-class and Opus-class reviews with pinned identities.

Quarantine suspicious revisions. A confirmed-malware ban requires verified evidence under the approved standing policy. Block execution, skill routes, and stale cached access. Notify authorized operators, owners, and known contributors without private evidence. Without an approved isolation profile, offer only read-only work or environment setup.

An owner can appeal. A moderator who did not impose the restriction decides it. Reinstatement needs a fresh complete scan after the restriction, current source and template checks, and a recorded reason. A clean scan alone does not cancel a ban. The new listing revision needs clearance before skills publish. Preserve obligations and history.

### Report and decide privately

A program requires project opt-in, verified GitHub private intake, approved terms, funding, named technical and financial reviewers, and independent appeal authority. Bounty-only programs do not need a monthly contribution pool.

Any registered user can report. Route exploitable findings privately even when bounty eligibility is uncertain. Never fall back to a public issue. Use GitHub private advisories for technical evidence and restricted Slop records for terms, decisions, appeals, and payments.

Human verification of the real GitHub report establishes receipt, authorship, original time, and policy version. A draft, redirect, pasted link, or uncertain response is not proof. Keep the recorded time visibly human-verified. Current program roles authorize project maintainers; reporters cannot review their own reports. Technical and financial approvals are independent. Related-party awards require separate independent approval.

Eligibility requires human-confirmed critical severity and a safely reproduced path to covered funds loss. Actual loss is not required. Reject duplicate reservations. When capacity returns, fund the earliest eligible waiting report under its original terms. Preserve emergency intake and existing obligations during pauses.

Keep receipt, remediation, award, payment, and disclosure states separate. Use independent private patch review and exact-revision tests. Verify deployed mitigation separately. A fix, payment, or expired deadline never authorizes disclosure. Bind disclosure approval to exact redacted bytes and approved embargo changes. Reporter recognition needs separate consent.

### Pay a private award

SEC-05: the researcher receives 75% of the gross award; slop.cash receives 25%. This replaces the ordinary 2% commission. Add no ordinary payout or claim fee. Use gross amounts divisible by four minor units. A 100 USDC award pays 75 and 25. The report and its fix are one financial work unit unless approved terms say otherwise.

Reuse existing payment rails, wallet authorization, recovery, and finality checks, as approved on 22 October (#1011). Use a separate bounty vault and private ledger. Ordinary balances, cycles, notices, and account views must reveal no case-related amounts or changes. Restrict case identifiers, counts, queues, and totals.

Before finance prepares an unsigned owner commitment, obtain the reporter's consent to public-chain visibility of actor number, addresses, timing, and amounts. Put no case reference or report digest on chain. Do not silently convert USD obligations to USDC. Keep uncertain sends held; retry only after proved finalized failure. Finalized success is immutable.

Slop's recorded Umia commitment is $10,000 gross: $7,500 researcher and $2,500 Slop. It is not a verified deposit. Umia is an example, not an implementation dependency, special rail, or activation target. Implementation approval does not open a program or authorize a live payment.

## 9. Operations and launch decisions

ARC-01; NOT-01; DEP-01

Public pages use cached D1 data or published snapshots. Show observation times. On refresh failure, retain the last good value with a stale label. Sensitive actions recheck current authority. Registry failure must not block sign-in or Account.

Reuse existing services and components. Keep contributor traces, vetting evidence, and bounty cases in separate access systems. Operators need explicit roles, reasoned grants, and audited reads.

### Notifications

Use one Inbox for wallet changes, payout exceptions, project decisions, appeals, and case notices. Save each notice with the source change; replay must not duplicate it. Keep private notices generic. Read, acknowledged, provider-accepted, delivered, failed, and uncertain are different states.

Activity email is optional. Show the verified destination before opt-in. Bind consent to its exact version. A changed address needs new consent. Opt-out cancels queued activity mail and works during outages; opt-in does not send old history. Essential wallet-security and private-case notices use their separate policies.

Recheck roles and destinations before sending. Verify actual inbox receipt separately from provider acceptance. Bound retries; reconcile uncertain sends before retry. Escalate failed or overdue case notices to a current approved backup. Preserve cases when notification fails.

### Recorded decisions and remaining gates

| Area | Recorded decision | Remaining approval or evidence |
| --- | --- | --- |
| Authority | Repository PRD; D1 inventory; GitHub work; human awards; chain finality | Reconcile older trace, scoring, and key instructions before the affected action |
| Fees | Public awards and free-fund withdrawals: 2%; private bounties: 25%; no stacked fee | Keep historical terms; approve changes prospectively |
| Wallet recovery | Fresh account and wallet proof; two operators for redirected recovery | Wallet-change delay and funded-award expiry policy |
| Mainnet | Four approved networks; independent audit before deployment | Exact assets, finality, authority, counsel review, testnet results, and explicit activation |
| Fee conversion | Separate fee wallet; dry-run first; human withdrawals | Routes, limits, custody, and Solana role separation |
| Slopbot | Optional active-project review; shadow gates; no financial authority | Independent confirmation route; closure activation; new penalty values |
| Private programs | Critical plus potential funds loss; separate approvals and 75/25 payment | Capacity, safe-testing terms, loss definition, costs, deadlines, dispute powers, and activation per program |
| Moderation and evidence | Staging pilot: lalalune (18633264), drew-dot-com (202660855) | Qualify staging, Linux/KVM runtime, external retention/recovery controls, and production release |

Pilot roles do not grant contributor-trace, payment, signing, or score authority. Evidence access still needs a current external-controls attestation. Role selection does not prove backup, retention, or legal-hold controls. Robinhood Chain still needs its identity authority, first project, and execution approval. No unresolved choice permits an agent to select a policy default.

## 10. Confirm policy

MVP-00 • Product owner and maintainers

Approve scope, effective dates, and the applicable decisions in section 9. Reconcile trace, scoring, funding, and key rules before dependent work. Exit: the governing instructions agree; remaining gates have named owners.

## 11. Establish accounts and safe admission

MVP-01, MVP-02, MVP-12 • Identity and security owners

Prove real GitHub login, rename, denied access, sessions, optional social connections, recovery, and wallet consent on all four networks. Telegram requires real bot webhook delivery against the exact head.

Reject wrong-network signatures, reused challenges, concurrent changes, and unsupported wallets. Verify safe delayed activation. Prove unreviewed artifacts cannot execute. Exercise credential probes, network escape, hidden payloads, lost monitoring, missing models, and incomplete evidence.

Exit: identity and awards survive recovery; only the exact cleared revision can enter executable onboarding.

## 12. Publish projects and complete a contribution

MVP-03, MVP-04 • Project and skill owners

Complete all four setup steps with a real authorized repository. Resume drafts, preview both skills, submit an update, and approve it through `/admin`. Reject stale edits, lost authority, and repeated approvals. Same template and D1 revision must generate identical skill bytes.

Start outside a checkout, select bounded eligible work, and complete a real contribution with exact-revision evidence and signed attribution. Verify that contributor skills cannot open issues. Exit: an approved project and a real contribution use the cleared revision.

## 13. Qualify Slopbot and scoring

MVP-05, MVP-05a, MVP-09, MVP-09a • Bot and scoring owners

Prove hosted review, registry eligibility, source freshness, cost records, budgets, invoice reconciliation, and duplicate-free milestone notices. Cover marked, registered, external, ignored, exempt, and unknown actors. Stop jobs after source changes, permission loss, suspension, or App removal.

Verify source-complete September and October assessments, live Eliza projection, shared attribution, indirect merges, review outcomes, equal ranks, corrections, and missing-data states. Preserve the section 7 cutoffs and frozen cycles.

Qualify closure separately: the three approved objective defects, counterexamples, two grounded independent verdicts, unchanged source, appeals, reopen protection, limits, and no duplicate penalties. Exit: both 14 days and 50 shadow reviews pass. Neither the earliest effective date nor a merge enables closure.

## 14. Prove funding and payment

MVP-05b, MVP-06, MVP-07, MVP-07b, MVP-07c • Protocol, security, and finance owners

MVP-07a is retired. Use the shared vault and current payment rules. Run this scenario on Base Sepolia, the approved Solana test cluster, Robinhood Chain Testnet, and Ethereum Sepolia:

1. Deposit 1,000 units of the specified test stablecoin.
2. Approve 100 gross for a registered actor and 50 for an actor without a wallet.
3. Reserve 150; verify 850 free.
4. Pay the first actor 98 and the fee wallet 2.
5. Register the second wallet; pay 49 and 1.
6. Repeat dispatch; verify no duplicate payment.
7. Withdraw 850; verify 833 to the owner's refund destination and 17 in fees.
8. Rebuild and reconcile balances, obligations, and finalized receipts.

Repeat with supported project tokens at 0, 6, 9, and 18 decimals. Prove third-party deposits share one balance. Reject reserved-fund withdrawals, wrong destinations, assets, networks, and unsupported token behavior.

Exercise frozen tokens, failed recipients, low gas, partial results, uncertain sends, restarts, and manual/automatic replay. Verify wallet impersonation and stale bindings cannot redirect awards. Service charges apply once to free funds. Fee conversion needs dry-run and authorized testnet evidence; invalid routes, slippage, or size fail without affecting awards.

Use the required test assets, including a verified Robinhood test USDG supply route. A substitute token or local fork is not public-testnet acceptance. Exit: independent review and all network scenarios pass. Mainnet remains separately gated.

## 15. Complete private bounties and product flows

MVP-08, MVP-10, MVP-13 • Product, operations, privacy, and security owners

Complete every journey in section 7 and the private-case matrix in section 18. Verify exclusions, appeals, consent, cached reads, notices, and admin decisions through the real entry points. Compare desktop and mobile. Test keyboard, screen readers, reduced motion, 200% zoom, copy feedback, downloads, links, console output, and first-party requests.

Use authorized synthetic private cases. Keep technical evidence and unsanitized videos private. The owner authorized lalalune and SlopDotCash/slopdotcash for synthetic hosted testing; one account cannot prove independent approval. Exit: each program meets its own policy, funding, access, notification, and activation gates.

## 16. Migrate and release

MVP-11 • Release and operations owners

Preserve identities, X/Telegram connections, journals, wallet proof levels, historical terms, and receipts. Reconcile old transfers before creating obligations.

Use current `origin/development`, pinned dependencies, and exact-head repository checks, including `bun run verify` and real-browser E2E. Preserve unrelated work. Record steps, expected and actual results, source revision, and limitations. UI changes need walkthrough and evidence videos.

Development deploys to isolated staging. Promote to `main` by reviewed PR and protected workflow. Verify served bytes, APIs, DNS, TLS, redirects, and headers. Verify contract deployment, providers, recovery, alerts, access removal, and authorized payments separately. Humans deploy mainnet contracts and manage keys. A production pilot requires explicit authorization and remaining legal/security approvals.

Rollback stops new actions; it cannot erase history, reverse finalized transfers, or restore obsolete wallets.

## 17. Completion record

Maintainers approve completion only when every requirement and blocking defect has a recorded result. For each requirement and MVP package, record the owner, exact source and deployed revisions, real workflow evidence, unresolved limits, and approval date. Include provider, security, chain, notification, and recovery evidence where required.

A document, local test, merge, or deployment alone is not completion. Approve the next phase separately.

## 18. Private bounty acceptance

SEC-01–18; MVP-13 • Use isolated staging, synthetic cases, and an authorized GitHub repository.

| Check | Required result |
| --- | --- |
| Program | Different amounts and sponsors; permanent terms; bounty-only setup; named payer, independent reviewers, deadlines, and dispute powers |
| Intake | Enabled, disabled, stale, denied, unavailable, direct, and interrupted paths; verified authorship, receipt time, policy, and evidence version; no public fallback |
| Eligibility and fix | Critical plus potential funds loss; safe reproduction; exact private patch review; independent tests; deployed mitigation |
| Access and decisions | Refuse self-approval, cross-case/project access, and revoked roles; separate technical, financial, appeal, and disclosure authority |
| Capacity | Verified funds versus pledges; one reservation per finding; concurrent exhaustion; earliest waiting receipt after replenishment; independent related-party approval |
| Amounts | 10,000 gross pays 7,500 and 2,500; reject inexact minor-unit splits and stacked fees; preserve the agreed asset and historical terms |
| Payment and recovery | Reporter chain consent; correct vault, asset, destination, and unsigned owner request; missing wallets, changed destinations, partial results, uncertain sends, restart, and replay; finality before paid |
| Privacy | No case data, counts, or revealing totals in public pages, APIs, logs, analytics, caches, downloads, rankings, or notices |
| Disclosure | Exact redacted-content approval and embargo history; separate recognition consent; no automatic publication after fix, payment, or deadline |
| Compatibility | No second cash award for the same report/fix; preserve ordinary rewards for separate eligible work |
| Notices | Verified sender, binding, destination, current role, quota, isolation, inbox receipt, explicit acknowledgment, bounded retry, and escalation |
| Continuity | Restore backups; preserve obligations through account recovery, role loss, project transfer, ban, closure, and intake outage |
| Release | All section 7 journeys, accessibility checks, sanitized evidence, and exact deployed revision |

For the Umia example, prove the gross reserve and researcher payment. Do not invent a self-transfer or external revenue for Slop's retained share. Program activation remains a separate human decision.

## 19. Open issue coverage

Reviewed 22 October 2026: all 18 open issues and their comments. The table records remaining evidence, not completion.

Issue comments can correct an older issue body. An open PR does not prove merge, deployment, or acceptance.

Requirement and MVP package IDs remain stable.

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
| [#909](https://github.com/SlopDotCash/slopdotcash/issues/909) | VET-01–08; MVP-12 | Merged capture and source/release comparison work preserves exact private evidence. Complete hostile-runtime coverage, independent provider reviews, and deployed clean/incomplete/malicious acceptance. |
| [#910](https://github.com/SlopDotCash/slopdotcash/issues/910) | SEC-01–18; MVP-13 | PR #1011 is merged. Complete hosted private intake, independent approval, 75/25 settlement, recovery, and the full program matrix. Source integration does not prove activation. |
| [#911](https://github.com/SlopDotCash/slopdotcash/issues/911) | ADM-05/06; ELG-02; MVP-10 | Qualify authorized staging moderation, appeal, independent review, and a fresh complete scan. The staging configuration is merged; production authority remains separate. |
| [#912](https://github.com/SlopDotCash/slopdotcash/issues/912) | NOT-01; MVP-10 | Verify deployed inbox and email preferences, persistent consent, withdrawal, replay protection, actual delivery, and separate acknowledgment. |
| [#913](https://github.com/SlopDotCash/slopdotcash/issues/913) | MVP-11; completion record | Record every requirement, owner, exact revision, real workflow result, release result, and resolved blocker. Obtain maintainer approval. |
| [#914](https://github.com/SlopDotCash/slopdotcash/issues/914) | All MVP packages | Keep the completion tracker aligned with this PRD. Separate source, test, deployment, service, device, and payment evidence. |

## 20. Source and change control

The repository file docs/slop-product-requirements.md is the single authoritative PRD. Approve changes through repository review, then update the Google Docs mirror. If the copies differ, the repository governs.

Reviewed against development `41d354d5`, all 18 open issues, lalalune's recent feature and repair PRs, and the application route/form inventory. Source review does not prove live end-user acceptance. Key accepted changes: [UX repair #997](https://github.com/SlopDotCash/slopdotcash/pull/997), [value scoring #993](https://github.com/SlopDotCash/slopdotcash/pull/993), and [integrated security, payment, and Telegram work #1014](https://github.com/SlopDotCash/slopdotcash/pull/1014). Historical detail supports implementation; this PRD governs current scope.

[Historical technical requirements](https://github.com/SlopDotCash/slopdotcash/blob/0dca651873548aa9ba06636ceba154652604a26d/docs/slop-product-requirements.md)

[Objective quality closure rules](https://github.com/SlopDotCash/slopdotcash/blob/0dca651873548aa9ba06636ceba154652604a26d/docs/slopbot-quality-closure-proposal.md)

The former delivery plan is consolidated here. Its package IDs, release gates, private-bounty checks, and completion requirements remain in force.

Record each change with the requirement ID, decision owner, approval, and effective date. Preserve historical obligations.

Owner direction, 22 October 2026: emphasize both contribution and security; keep the repository PRD authoritative and Google Docs as its mirror. The 25% private-bounty commission replaces the ordinary 2% fee.

Language follows ASD-STE100 principles. Full dictionary conformity has not been certified.
