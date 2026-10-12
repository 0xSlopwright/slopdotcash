# Slop escrow contracts: AI-assisted security review

**Status:** internal, AI-assisted review. Not an independent audit.
**Date:** 12 October 2026
**Commissioned and reconciled by:** Drew Pierson (Operator, Slop Cash S.P.), using Claude Fable 5.1 as lead reviewer. Drew is not independent of the project and is not a security engineer. The contract author (Shaw Walters) did not take part in the review.
**Code reviewed:** SlopDotCash/slopdotcash `main` at commit `bbcc87b91c3ef952313eb5669112865fc311be4a` (12 Oct 2026 16:56Z)

- `contracts/evm/src/ProjectEscrow.sol` (contracts `ProjectEscrow` and `EscrowFactory`), 295 lines, Solidity 0.8.30, plus `contracts/evm/script/DeployBase.s.sol` and `DeployBaseSepolia.s.sol`
- `contracts/solana/programs/slop-escrow/src/lib.rs`, 585 lines, Anchor 0.32.1, classic SPL Token only

**Deployment state at review time:** no mainnet deployment on either chain, no public testnet deployment recorded, every project manifest has payments disabled. No funds are at risk today.

## 1. Headline

No reviewer found a way for an unprivileged party to take or lock funds, choose a payment amount or destination, pay an award twice, or touch reserved funds. The accounting is sound: fee arithmetic, reserve tracking and the conservation identities in both READMEs held under every tested sequence, including 256 fuzzed runs of 500 random calls each on the EVM contract.

The findings are design-level and concentrated in one area: the wallet-binding lifecycle (identity authority, binding delay, owner cancel). Three findings should be fixed before any mainnet deployment, and each fix is small.

| Severity | Count | Summary |
|---|---|---|
| Critical | 0 | |
| High | 1 | The identity authority key has no recovery path. A lost key permanently strands unpaid awards for actors without an active binding; a compromised key turns into a perpetual 48-hour race. |
| Medium | 2 | The binding delay is measured from the binding, not from the award, so a binding placed before any award exists matures unnoticed and pays instantly later. The owner can cancel or veto bindings without bound, so a committed award can be blocked forever. |
| Low | 5 | Unbounded delay parameter; Solana fee leg inside `pay`; Solana parameters set by the owner with no on-chain pinning; three EVM input checks missing on Solana; EVM cancel re-emits events. |
| Informational | 7 | Event completeness, documentation drift, dead constraints, a registrar foot-gun. |

Two items outside the contracts are recorded in section 6 because they bear on how this review may be described: who holds the identity authority key, and the Solana program upgrade authority.

## 2. Method

Five independent reviews were run against the same commit, each with a distinct brief, by three different Claude models, and then reconciled by a lead model with every claim re-checked against the source:

| Reviewer | Scope | Model | Evidence produced |
|---|---|---|---|
| A | EVM contract, factory, deploy scripts | Claude Opus | 19 Foundry tests: 9 scenario tests, 5 token-behavior tests, 5 invariant suites (256 runs x 500 calls each) |
| B | EVM contract, factory, deploy scripts | Claude Fable | 17 Foundry tests including a 256-run withdrawal-split fuzz |
| C | Solana program | Claude Opus | Reasoning against the program and the locked Anchor 0.32.1 and spl-token 8.0.0 sources |
| D | Solana program, role by role | Claude Fable | Reasoning against the program and the generated Anchor constraint code |
| E | Fee arithmetic, conservation identities, EVM vs Solana parity, events, docs | Claude Sonnet | 11 Foundry tests including a 256-run split fuzz with identities asserted after every step |

The 47 Foundry tests all pass on this commit (`forge test`, Foundry 1.7.1, solc 0.8.30). The repository's own EVM integration suite (`bun contracts/evm/adapter.integration.ts`, real Anvil deployment) also passes. `cargo check --locked` is clean for the Anchor program. No Solana validator was run for this review; the repository's CI runs the Anchor end-to-end suite and section 7 lists what that suite does not cover.

Reconciliation rules: a finding appears below only if the lead could reproduce the reasoning against the code or a passing test demonstrates it. One reviewer claim was rejected: that the EVM `uint64(block.timestamp) + bindingDelay` wraps silently. Solidity 0.8 checked arithmetic reverts instead, which two other reviewers' tests confirmed. Where reviewers disagreed on severity the lead's choice and the reason are stated.

Out of scope: the off-chain adapters, the payment executor and scanner workers, the identity attestation service, key custody, deployment procedures, the Squads 2-of-3 project vault, and every other part of the Slop codebase. Those are a larger surface than the contracts and have not been reviewed by anyone.

## 3. Trust model used

| Role | Documented power | Must not be able to |
|---|---|---|
| Project owner (sponsor) | Deposit; commit awards (reserving gross); withdraw free funds (10% fee on cumulative gross withdrawn); pay a Slopbot invoice from free funds; cancel or veto a binding while it is pending | Take back, reduce or redirect a committed award; reach reserved funds |
| Identity authority | Bind a numeric GitHub actor id to a wallet, versioned, subject to the delay | Change amounts; touch free funds or paid awards |
| Payer or relayer (anyone) | Trigger payment of a committed award to the active binding | Choose amount or destination |
| Fee recipient | Receive fees | Block payouts or refunds |
| Factory registrar (EVM) | Create one vault per project id | Move money |
| Upgrade authority (Solana) | Replace the program | Exist on mainnet (must be `null`) |

Documented and accepted, so not reported: the owner can commit an award to an account it controls and exit at the 2% payout fee instead of the 10% withdrawal fee; direct token transfers to a vault are unrecoverable; there is no award cancellation and no rescue; a blocklisted contributor destination reverts that one payment.

## 4. Findings

### H-1. The identity authority key has no recovery path (both chains)

Reviewers: A (Medium), B (High), C, D. Lead rating: High, because the brief's rule is that a permanent lock of funds is High even without theft, and the authority will be a hot service key.

The only way an actor becomes payable is a binding signed by the identity authority. On EVM that key is an immutable set once per factory (`ProjectEscrow.sol:38`, `EscrowFactory` constructor); on Solana it is set once per project at `initialize` (`lib.rs:28`). There is no rotation, no multi-party recovery, no award cancellation and no reserve rescue on either chain.

- **Key lost:** every award committed to an actor that has no active binding at that moment can never be paid. Its gross stays reserved forever and the owner cannot withdraw it (`withdrawUnused` and `chargeService` only reach `freeBalance`). On EVM this is factory-wide.
- **Key compromised:** the attacker can bind any actor to itself. The owner can cancel each rogue binding during the delay, but only the compromised key can make an honest binding, so the attacker rotates again. The owner must win every 48-hour window forever; one missed window is theft. The attacker can also rotate away an active honest binding, which destroys it (see M-2).

Evidence: `test_F1_lostAuthorityStrandsUnpaidAwards` (B) and `test_F3_compromisedAuthorityConvertsToLockOrTheft` (A), both passing.

Recommendation: add a constrained rotation that gives no single party a new money power, for example a two-step authority replacement proposed by the owner and confirmed by a second fixed party, itself subject to the binding delay and vetoable by the current authority. Alternatively let the owner re-point an unpaid award's actor only after that actor has had no active binding for a long fixed period, under the same delay and with an event. At minimum, state the no-recovery property in both READMEs next to the redirect risk, and make a documented key ceremony and operational recovery plan a hard launch gate. The EVM README already lists "operational signer recovery" as a launch gate; it does not say what the consequence of failure is.

### M-1. The binding delay protects awards that exist at bind time, not awards committed later (both chains)

Reviewers: A, D (independently). Lead rating: Medium.

`pay` requires only `now >= activatesAt` (`ProjectEscrow.sol:191`; `lib.rs:157-160`), and the owner's cancel is allowed only while `now < activatesAt` (`ProjectEscrow.sol:180`; `lib.rs:138-141`). Nothing ties either to when an award is committed. A binding for an actor with no award puts nothing at risk while pending, so no owner has a reason to look at it. After 48 hours it is final and covers every future award to that actor.

Scenario: a compromised authority binds future contributors to the attacker's wallet. Forty-eight hours pass. Weeks later the owner commits an award to one of those actors. In the same block, any relayer's `pay` sends the net amount to the attacker. The owner's cancel reverts because the binding is active. On Solana, because bindings are shared across every project with the same authority and network (`lib.rs:384`), one pre-placed binding exposes every future award to that actor in every project. The intended product flow (`docs/payouts-mvp.md:15`) has contributors register wallets before they have awards, so a malicious early binding looks like a normal one.

Evidence: `test_F1_preArmedBindingPaysInstantlyAfterCommit` (A), passing. The Solana end-to-end suite always binds after committing, so this ordering is untested there.

Recommendation: record the commit time on each award. Require `now >= max(activatesAt, committedAt + bindingDelay)` in `pay`, and allow the owner's cancel or veto until that same moment. This gives the owner a window measured from the moment money is attached to the binding. The off-chain alternative is to have the owner (or the executor acting for it) read the current binding before every commit and refuse to commit against a binding it has not reviewed; if that is chosen, document it as a required operating procedure.

### M-2. The owner can block a committed award indefinitely; rotation strips an active binding (both chains)

Reviewers: A, B, C, D, E (all five). Lead rating: Medium. One reviewer rated Low on the ground that it is the documented power applied repeatedly; the lead kept Medium because the README's wording ("delay", "an active binding is final") is weaker than the code.

Cancel (`ProjectEscrow.sol:178-185`) and veto (`lib.rs:132-148`) are one per binding version, but versions are unbounded. Each honest rebind by the authority opens a new window the owner can cancel again. The reserved funds stay locked; the owner cannot withdraw them either. This is mutual loss, not theft, but on chain it has no bound.

Separately, a rotation overwrites the single stored binding, even a rotation to the same destination. The previously active version becomes unpayable at once, because `pay` requires the current version. If the owner then cancels the replacement, the actor has no payable binding at all although it had a final one minutes earlier. The README sentence "An active binding is final and cannot be cancelled" is therefore not true under rotation plus cancel.

Evidence: `test_F2_ownerCanBlockCommittedAwardIndefinitely` (A, 25 rounds), `test_F2_activeBindingLostAfterRotateAndCancel` (B, 10 versions), `test_repeatedCancelBlocksForever` and `test_activeBindingSupersededThenCancelled` (E), all passing.

Recommendation: keep the previous active binding payable while a replacement is pending (store the active destination separately from the pending one and promote on activation), so a rotation can only move the destination after the delay and a cancel only drops the pending change. If the unbounded block is intended policy, say so in the README and the PRD and drop the "final" sentence. A cap on cancels per actor per project is the smallest code change.

### L-1. The binding delay has no on-chain bounds (both chains)

Reviewers: A, B, C, D, E. Both constructors accept any delay. On EVM a delay near `uint64` max makes every `bindDestination` in every vault of the factory revert, and a delay of exactly `2^64 - 1 - now` creates a binding whose `activatesAt` equals the cancel sentinel, so it can never pay. A delay of zero makes cancel unreachable. On Solana `i64::MAX` makes `pay` and `veto_binding` fail with `Arithmetic` forever, and a merely large value never activates. The 48-hour production minimum exists only off chain (`src/lib/escrow-policy.mjs:30`), and both deploy scripts hard-code 48 hours. Evidence: `test_F4_hugeDelayBricksBinding`, `test_F3b_sentinelCollision`, `test_F4_zeroDelayMakesCancelUnreachable`, passing. Recommendation: require a minimum and a maximum in both constructors, and replace the EVM sentinel with an explicit cancelled flag.

### L-2. On Solana the fee leg runs inside `pay`, so a frozen fee token account stalls executor-built payouts (Solana)

Reviewers: C, E (D rated it sound). `pay` always sends two transfers, including a zero-amount fee transfer, to a `fee_account` that need only be owned by the fee recipient (`lib.rs:178-186, 414`). SPL Token rejects a frozen destination before it looks at the amount. If the fee recipient's associated token account is frozen, every `pay` built by the executor fails across every project sharing that fee recipient, including zero-fee awards, because the executor uses the ATA (`workers/payment-executor/solana.ts:548`). Anyone can create a fresh token account owned by the fee recipient and pass it, so this is a liveness issue, not a lock; the EVM side avoids it by accruing fees and claiming them separately. Recommendation: skip the fee transfer when the fee is zero, and make the executor able to fall back to another fee-recipient-owned account; or accrue fees on Solana as on EVM.

### L-3. Solana `initialize` is permissionless and every security parameter is chosen by the owner (Solana)

Reviewers: C, D, E. The owner picks the identity authority, fee recipient, delay, network and mint; the only checks are non-default keys, authority not equal to owner, and delay non-negative (`lib.rs:17-23`). An owner could name a second key it holds as authority, bind each actor to its own wallet and take committed awards back at 2%; or set the fee recipient to itself. Today the adapter refuses any project whose stored values differ from the reviewed manifest (`contracts/solana/adapter.ts:131-206`), so the guarantee rests on manifest review. The EVM factory pins token, fee recipient, authority and delay in code and gates creation behind the registrar. Recommendation: add `fee_recipient != owner`, a delay maximum and `fee_recipient != project PDA` on chain, and consider a one-time global config written before the upgrade authority is burned so the authority and fee recipient are pinned on chain as on EVM. Document the manifest check as the gate until then.

### L-4. Three EVM binding checks are missing on Solana (Solana)

Reviewers: C, D, E. `bind_wallet` accepts a zero `claim_digest`, a destination equal to the project or vault PDA, and has no submission expiry (`lib.rs:104-107`); EVM rejects all three (`ProjectEscrow.sol:164-167`). A destination equal to the project or vault PDA passes `pay`'s check (which only excludes the vault address itself, `lib.rs:412`) and strands the principal in an associated token account the program can never sign for. A bind transaction signed with a durable nonce stays valid until the version changes. Only the authority can trigger these, but they convert a redirect into an unrecoverable burn. Recommendation: add the three checks.

### L-5. EVM `cancelBinding` is idempotent on a cancelled binding and re-emits the event (EVM)

Reviewers: A, B. After a cancel, `activatesAt` is the sentinel, so the "already active" guard never fires and the owner can cancel the same version again at any later time, emitting duplicate `BindingCancelled` events (`ProjectEscrow.sol:180`). State is unchanged. Evidence: `test_F5_cancelIsRepeatable`, `test_F4_cancelIsIdempotentAndReemits`, passing. Recommendation: revert when the binding is already cancelled.

### Informational

- **I-1. Solana events are thinner than EVM events.** No deposit or initialize event; `AwardPaid` lacks the actor id and the token accounts; `UnusedWithdrawn` lacks the destination; `WalletBound` lacks the claim digest and authority. The adapter reconciles from instructions, not logs, so nothing breaks today; third-party indexers get less. On EVM, `Paid.fee`, `UnusedWithdrawn.fee` and `ServiceCharged.amount` are accruals; tokens move only at `FeesClaimed`.
- **I-2. The Solana award id has no cluster domain.** The same program, owner and project id on devnet and mainnet give identical award ids. Not replayable on chain; an off-chain store keyed on award id alone could mix clusters. EVM includes the chain id.
- **I-3. `chargeService` digest uniqueness is a client-side property.** The digest is not tied to the amount or to a signed invoice, and there is no cap. All of it goes to the fee recipient, so it is not an attacker drain, but the contract cannot enforce any invoice policy.
- **I-4. The EVM registrar can create a dead vault.** The constructor does not reject `owner == address(this)` (the CREATE2 address is predictable), and a consumed project id cannot be retired in that factory. No funds at risk unless someone sends tokens to the dead vault.
- **I-5. Documentation drift.** "Splitting cannot reduce fees" is true for withdrawals only; per-award flooring means three 49-unit awards pay zero fee where one 147-unit award pays 2 (under one micro-unit per award, uneconomic). A single withdrawal step can be 100% fee (gross 1 after cumulative 9 returns 0). The EVM README's third conservation identity cannot be checked on chain (no claimed-fees counter). The Solana README's identity is a tautology because `free()` is defined as the remainder; the real invariant is `vault.amount = free + reserved + unsolicited`, which holds. `EscrowFactory` reuses `DuplicateAward` for a duplicate project id. `expiresAt` is neither stored nor emitted. `docs/payouts-mvp.md:17` says "Contracts enforce ... fees", which on Solana is only true via the manifest (L-3).
- **I-6. Issuer freeze of the vault itself.** If the token issuer freezes a vault's token account, reserved and free funds are locked with no recovery path on either chain. Outside the program's control; neither README mentions it.
- **I-7. Shared bindings on Solana.** One legitimate rotation reopens the veto window in every project with the same authority and network and resets expected versions everywhere. Each project must veto separately. Documented in the README; recorded here because M-1 and M-2 compound across projects on Solana only.

## 5. Checked and found sound

Each item was examined by at least two reviewers and re-read by the lead.

- **Reentrancy (EVM):** one guard across every money path; state is fully updated before any transfer in `pay` and `withdrawUnused`; commit, bind and cancel make no external calls. A reentry during `pay` is blocked (`test_reentryDuringPayIsBlocked`). Solana token CPIs cannot call back into the program.
- **Exact transfers (EVM):** `deposit` checks the vault delta; `sendExact` checks vault and recipient deltas; destination can never be the vault, so the two reads are on distinct addresses. Fee-on-transfer and rebasing tokens revert cleanly with no counter drift. `callToken` accepts empty return data and a 32-byte `true`, rejects `false` and 64-byte returns.
- **Binding lifecycle:** cancel and pay windows meet exactly with no overlap; a cancelled or vetoed version never pays; a version that does not exist yet cannot be pre-cancelled or pre-vetoed on either chain; a stale `pay` with an old version fails after rotation.
- **Veto account tamper (Solana):** the veto PDA can gain data or a non-system owner only through this program's `veto_binding`; sending lamports to the address leaves `pay` passing; Anchor's `init` handles pre-funded addresses, so dusting cannot block veto, commit, initialize or a first bind.
- **Account validation (Solana):** every account a transfer touches is pinned by PDA derivation or `has_one` back to the project; the program signs only with the project PDA over its own vault; Token-2022 accounts and mints are rejected everywhere; `init_if_needed` on the binding cannot re-initialize because a created account always ends at version 1 or higher and there is no close instruction; PDA seed prefixes are pairwise non-prefix and every seed component is fixed width.
- **Replay and duplicates:** `paid` flags are permanent on both chains; no close instruction exists on Solana so account recreation is impossible; award ids are bound to chain and vault (EVM) or project PDA (Solana); the EVM factory rejects a duplicate project id and there is no `selfdestruct`, so CREATE2 redeploy is impossible.
- **Reserves and conservation:** both README identities hold after every tested sequence including `chargeService`; the owner cannot reach reserved funds by any instruction; a blocked contributor destination leaves the reserve intact and the award unpaid.
- **Fee arithmetic:** `gross/50` never exceeds gross and net is always at least 1; the withdrawal fee is path independent, never negative, never exceeds the step's gross; results are identical on both chains for every worked example.
- **Integer bounds:** every counter is bounded by total deposits, which cannot exceed `2^64 - 1` micro-USDC; timestamps cannot truncate; all Solana arithmetic is checked.
- **Role powers:** the authority cannot touch amounts or funds; the permissionless payer selects neither amount nor destination; a fee-recipient blocklist blocks only `claimFees` on EVM; an owner of a different Solana project with the same authority can veto only its own project and reserve only its own funds.
- **Deploy scripts:** chain id pinned (8453 and 84532), no private key material, Base mainnet USDC and the fee recipient constants match `src/lib/fresh-cycle-policy.mjs` and the PRD.

## 6. Items outside the contracts that affect how this review may be described

- **Who holds the identity authority.** `bindDestination` and `bind_wallet` accept any destination from the authority alone; no wallet proof is checked on chain. The payouts MVP describes this as a Slop-run attester. The product requirements (section 22, merged as #557) say no Slop-held key may originate, route or redirect a payment. These conflict. The decision is Shaw's and must be settled before any deployment; until then, public copy should not describe the escrow as non-custodial without qualification, and this review should not be cited as having resolved it.
- **Solana upgrade authority.** A retained upgrade key can replace the program and empty every vault. The README and the adapter require `null` on mainnet. That is a launch gate, not a finding, and this review did not verify any deployment.
- **Independent audit.** This review was produced by models under the direction of a non-independent operator. It is a pre-audit. An independent review before any mainnet escrow remains the plan.

## 7. Test coverage gaps in the repository's own suites

The Solana end-to-end suite (`contracts/solana/integration/escrow.e2e.mjs`) does not exercise: commit after a binding is already active (the M-1 ordering); a second veto on the next version; two projects sharing the authority with different delays; `pay` with a non-ATA fee account owned by the fee recipient, or with a frozen fee account; a veto for a version that does not exist yet; lamport dust at the veto, obligation and origin addresses before creation; `withdraw` to a non-owner token account; `deposit` by a non-owner; `initialize` with authority equal to owner, a negative delay, a Token-2022 or non-six-decimal mint; an off-curve destination; a zero-fee award under 50 units; a zero claim digest; two `pay` instructions in one transaction; the exact activation instant.

The EVM integration suite does not exercise the M-1 ordering, repeated cancel, rotation of an active binding, or extreme delay values. The 47 review tests cover all of these for EVM and can be adopted into `contracts/evm/test/`.

## 8. Recommended order of work

1. Decide the identity-authority holder and recovery design (H-1, section 6). This is a product and legal decision before it is a code change.
2. Land the three binding-lifecycle fixes together on both chains: delay measured from commit as well as bind (M-1), active binding survives a pending rotation (M-2), bounded delay with an explicit cancelled flag (L-1).
3. Land the small Solana hardening: zero-digest, destination and expiry checks (L-4); `fee_recipient != owner` and delay maximum at `initialize` (L-3); skip the zero fee transfer (L-2).
4. Update both READMEs (M-2 wording, no-recovery property, I-5 items) and `docs/payouts-mvp.md:17`.
5. Adopt the review tests and close the end-to-end gaps in section 7.
6. Independent audit before any mainnet deployment.

## Appendix: reviewer reports and tests

Raw reviewer reports: `docs/security/escrow-ai-review-2026-10-12/` (five files: `evm-fable.md`, `evm-opus.md`, `solana-fable.md`, `solana-opus.md`, `parity-sonnet.md`). Foundry tests: `contracts/evm/test/` (six files, 47 tests). Run with `forge test --root contracts/evm` from the repository root. The repository's escrow CI workflow does not run `forge test`; it runs the Bun adapter integration suite against a local chain.
