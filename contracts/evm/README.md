# EVM escrow v4

This is an immutable escrow implementation for one project and one token. The
token can be any standard ERC-20 with any decimals: Circle USDC, Paxos USDG or
a project token. One factory on each chain creates one vault for each
(project ID, token) pair. It
has no proxy, owner change, token approval, arbitrary call, rescue, claim
expiry, or award cancellation entry point. An approved award remains reserved until it is paid. The owner can cancel only a wallet binding that has
not paid yet, and only inside a bounded window. The only mutable authority is
the factory's identity authority, replaced by a public 7-day timelock. This
code has local EVM execution evidence only. It has not received an independent
security review or a public testnet deployment.

## Networks

| Network | Chain id | Reference asset (not an allowlist) | Deploy script |
| --- | --- | --- | --- |
| Base Sepolia | 84532 | Circle test USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | `DeployBaseSepolia.s.sol` |
| Base | 8453 | Circle USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `DeployBase.s.sol` |
| Robinhood Chain Testnet | 46630 | Paxos test USDG `0x7E955252E15c84f5768B83c41a71F9eba181802F` | `DeployRobinhoodTestnet.s.sol` |
| Robinhood Chain | 4663 | Paxos USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | `DeployRobinhood.s.sol` |
| Ethereum Sepolia | 11155111 | Circle test USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` | `DeployEthereumSepolia.s.sol` |
| Ethereum | 1 | Circle USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | `DeployEthereum.s.sol` |

The Ethereum USDC addresses come from Circle's
[USDC contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses)
page. On 18 October 2026 an `eth_call` on each chain returned symbol `USDC`
and 6 decimals. `src/lib/escrow-policy.mjs` records each reference asset with
its decimals and source. The registry lists reference assets only; a project
can fund a vault in any standard token.

The contract reads only `block.timestamp` and `block.chainid`, never `block.number`, so Arbitrum Nitro's block-number semantics on Robinhood Chain do not affect award ids or delays. `foundry.toml` targets Cancun. Opcode support on Robinhood Chain is not yet proven: the first testnet deployment must record the ArbOS version read from the `ArbSys` precompile and a successful deployment receipt before any activation.

## Authority and identity

The factory registrar creates one vault for each nonzero project ID and token
in that factory and holds no money power. The registrar, the fee recipient and
the identity authority are explicit constructor parameters; the deploying
account holds no role. Anyone can deposit. The project owner approves awards
and withdraws free funds to an immutable refund address. The identity authority
is a factory-level address that every vault reads; it is Slop's attester key. A
binding needs two signatures. The identity authority submits the
`bindDestination` transaction, and the destination wallet signs an EIP-712
message over the chain ID, vault, actor ID, destination, expected predecessor
version, wallet-claim digest and expiry (`DestinationBinding` under the
`SlopProjectEscrow` version `4` domain). The vault recovers the signer with
`ecrecover` and rejects a binding whose signer is not the destination, so the
authority alone cannot point funds at a wallet it does not hold. Only an
externally owned account can produce that signature; a contract wallet cannot
be bound in this version. Anyone can call `pay`; the caller cannot select the
amount or destination. The registrar must enforce the project's single-network
manifest choice across chains. A factory cannot enforce another chain's
registry, and separate factory deployments cannot prevent duplicate project
registration globally.

The authority's transaction signature binds the chain ID and contract address,
and the wallet signature binds the same fields through its domain, so there is
no reusable attestation blob. Each binding includes a reviewed wallet-claim
digest, an expected predecessor version, and an expiry that bounds submission
of both signatures. Once accepted, the binding persists. The authority must
independently verify GitHub login and the current registered claim before
submission. A compromised authority cannot redirect unpaid funds on its own;
with a colluding wallet it can propose a new destination, which the delays
below exist to catch. It cannot change awards or withdraw funds. Two delays
limit that risk, both of length
`bindingDelay`. A new or rotated binding activates `bindingDelay` seconds after
it is made. An award can be paid only `bindingDelay` seconds after it is
committed (`committedAt`), so a binding placed before the actor had any award
still gives the owner a full delay measured from the moment money is attached
to it. The owner's exact power is `cancelBinding(actorId, version)` on the
latest binding, allowed while that binding waits out its own delay or while an
award to the actor is inside its commit delay, and never on a binding that has
already paid. A cancelled binding never pays; only a new binding (the next
version, with a new delay and a new wallet signature) can follow. Between two
payments to an actor, the owner can cancel at most `MAX_CANCELS_BETWEEN_PAYMENTS`
(3) times; the next binding cannot be cancelled and pays after its delay. A
payment resets the count. The owner can therefore delay a
contributor's payout by a bounded number of delays, but can never take an
approved award back or redirect it. The constructor rejects a delay below one
hour or above 30 days; production deployments use at least 48 hours
(`MIN_PRODUCTION_BINDING_DELAY`), and the adapter checks the deployed
`bindingDelay` against the reviewed manifest. Use separate test identities for
the owner, attester, registrar, and gas sponsor.

### Identity authority rotation

The factory holds `identityAuthority` and one pending replacement. The
registrar calls `proposeIdentityAuthority(next)`; the proposal is public in
`IdentityAuthorityRotationProposed` with its effective time, 7 days after the
proposal (`AUTHORITY_ROTATION_DELAY`). The registrar can cancel its own pending
proposal with `cancelIdentityAuthorityRotation`. After the effective time
anyone can call `executeIdentityAuthorityRotation`, which emits
`IdentityAuthorityRotated`; the current authority has no call that blocks or
delays it. Until execution the current authority keeps binding; afterwards only
the new one can. Bindings are stored per vault and actor and do not reference
the authority, so every existing binding, pending or active, stays valid across
a rotation, and `pay` never reads the authority. The next authority must be
nonzero and differ from the current authority and the registrar. Vaults are
created only by the factory and read `factory.identityAuthority()`. The reviewed
manifest pins the factory address, its runtime code digest
(`factoryCodeSha256`) and its registrar, and the adapter checks that the factory
created the vault for its project ID and has the reviewed asset, fee recipient,
binding delay and 7-day `AUTHORITY_ROTATION_DELAY`. A vault from a factory with
other rotation rules therefore fails verification. The manifest's
`identityAuthority` is the authority at activation; the adapter does not compare
it with the authority in force, because after activation the authority changes
only through this timelock. A rotation therefore never interrupts verification
or payment, and the manifest stays immutable.

### Key recovery runbook

Who acts: the registrar key (a reviewed multisig or hardware key, never the
attester service) and each project owner. The attester key is a hot service
key and is never used for recovery.

Attester key lost: the authority can no longer bind, so awards to actors
without an active binding wait; nothing is lost and no reserve moves. The
registrar proposes the replacement key, publishes the proposal transaction,
and executes the rotation after 7 days. Existing bindings keep paying
throughout. A contributor whose binding was pending or missing signs nothing
new unless the wallet signature already collected has expired.

Attester key compromised: the registrar proposes the replacement at once; the
exposure window is 7 days. During it the attacker can submit only bindings
that a wallet co-signs, each activating after `bindingDelay`. Every project
owner watches `DestinationBound` and cancels any binding it did not expect
with `cancelBinding`, which costs the contributor a delay and nothing else.
The owner cancels late in each binding's delay, so three cancels and the
fourth binding's own delay cover at least four delays: 8 days at the 48-hour
production minimum, longer than the 7-day notice. After execution the old key
cannot bind, and the new authority binds the contributor's wallet as the next
version before the attacker's last binding activates; only the latest binding
pays. `test_H1_stolenAuthorityCannotTakeAnAward` in `test/BoundedAttester.t.sol`
runs this sequence and asserts that the attacker receives nothing. Rotation
never cancels or re-points a binding by itself, so review every binding made
during the window.

Registrar key lost or compromised: there is no second rotation path; the
registrar is the recovery authority, so choose it at factory deployment and
record its custody in the deployment evidence. A compromised registrar can
propose a rotation to a key it controls, but still needs a wallet co-signature
per binding and still faces the delay and the owner cancel; the public 7-day
proposal is the notice to deploy a new factory for new projects.

Project owner key lost: deposits, awards and withdrawals from that vault stop;
reserved awards still pay to active bindings. There is no owner change in this
version.

Only the latest binding can pay. `bindings(actorId)` is the latest authority
binding with its `activatesAt` and `cancelled` flag. `payableBinding(actorId)`
returns it once its delay has passed and it is not cancelled, and version 0
otherwise. `paidVersion(actorId)` records the version the last payment used, so
that binding cannot be cancelled. While a rotation waits out its delay, or after
the owner cancels it, no caller can pay any earlier wallet: a contributor who
rotates away from a lost or compromised wallet freezes payment to it at once,
and payment resumes only to the new binding once it is ready. This is the
stale-binding rule in `docs/base-solana-payout-plan.md`: a finalized change
invalidates payment to the earlier destination. A payment names the version it
expects, and a payment naming any other version fails. If payment executes
first, a later rotation cannot repay the award. Every award ID and source
digest is consumed permanently. Source
digests identify a single allocation origin including project, cycle, and actor; keep it stable across amount or snapshot
revisions; do not supply a whole-cycle digest for each award. The award ID must
equal `awardId(sourceDigest)`, which is
`keccak256(abi.encode(chainId, vault, sourceDigest))`. Another vault cannot
claim the same ID first, so ledger IDs stay unique across projects.

The first version uses individual commit and pay calls. Dispatchers isolate
failed recipients by submitting separate transactions. No account can sweep
unclaimed awards. Missing destinations cause a revert and leave reserves intact.

## Accounting

All values are integer token base units, stored as checked `uint128`. The vault
stores `decimals()` once, for display only, and never scales an amount. Each
award reserves its gross allocation. The payout fee is `floor(gross / 50)` (2%)
and the recipient receives `gross - fee`. A 100-USDC award costs the project
100 USDC and sends 98 USDC to the contributor plus 2 USDC of fees. The 2% is
paid in the vault token. Each unused-fund withdrawal pays the same 2%:
`withdrawalFee(gross) = payoutFee(gross) = floor(gross / 50)`, rounded down once
per withdrawal (PRD section 18). Withdrawing 850 USDC of free funds pays 17 USDC
and sends 833 USDC to the refund destination. A withdrawal under 50 base units
pays no fee, so a split saves under one base unit per transaction, far less than its
gas. A one-unit award requires one unit of funding and has a zero fee; tiny
award rounding is intentional.

Payout and withdrawal fees accrue in the vault as `accruedFees`. Anyone can
call `claimFees()` to move them to the immutable fee recipient. A blocked fee
recipient (for example, a USDC blacklist) stops only `claimFees`; payouts and
refunds continue. Refunds go only to the owner: the constructor requires
`refundDestination == owner`.

`deposit(amount)` is permissionless. Any account approves the vault and calls
it; the vault pulls the exact amount from the caller, credits `freeBalance`,
and emits `Deposited(depositor, amount)`. All deposits join one free balance.
A depositor gets no refund right: only the owner commits free funds to awards
or withdraws them to its refund destination. Direct transfers to the vault are
not credited and cannot be rescued.

Deposits and transfers must move exact amounts. The vault compares balances
before and after each transfer, so a fee-on-transfer token reverts the deposit
or payment. Rebasing tokens break the balance identity and are not supported;
the contract cannot detect every rebase, so the registry review must reject
them. A token without a `decimals()` function that returns a `uint8` value is
rejected when the vault is created. Arbitrary tokens with dishonest
`balanceOf` results are outside the supported asset model. Token failures or
blocked recipients revert the full payment.

USDC and USDG are upgradeable proxies with a pause switch and a per-address
freeze. The contract fails closed: a frozen or paused recipient reverts `pay`
and the award stays reserved; a frozen fee recipient blocks only `claimFees`.

The conservation identities are unchanged by the binding lifecycle:

```
totalDeposited = freeBalance + reservedPrincipal + reservedFees
               + totalPaid + totalPayoutFees + totalGrossWithdrawn
               + totalServiceFees
vault balance  = freeBalance + reservedPrincipal + reservedFees + accruedFees
               + unsolicited direct transfers
accruedFees + claimed fees = totalPayoutFees + totalWithdrawalFees
                           + totalServiceFees
```

`totals()` returns every counter and the vault token balance in one call, so a
reader gets one consistent block. Each counter also has its own public getter.
The adapter's `readVaultTotals` reads `totals()`, `token()` and `decimals()` at
one pinned finalized block and checks the first identity.

`chargeService(amount, invoiceDigest)` (PAY-10) lets only the owner pay one
Slopbot invoice from `freeBalance`. The amount accrues for the fee recipient
like other fees. Each nonzero invoice digest can be charged once. It cannot
spend reserved principal or reserved fees.

The owner can commit an award to any GitHub actor, including an account the
owner controls. Because the withdrawal fee equals the payout fee (repository
owner decision of 19 October 2026, #907), such a self-award costs the same 2%
as a withdrawal and gives no fee advantage. Maintainer review of related-party
awards still applies under the eligibility policy.

`reservedPrincipal` records net contributor obligations; `reservedFees`
records their deducted fees. `totalWithdrawalFees` is included within gross
withdrawals. `totalPaid` is only contributor net. Event observations and
counters are not finality proof; backend receipts must use finalized chain
state. Before indexing an event or signing, the adapter verifies the finalized
runtime code SHA-256 and the token, owner, fee recipient, binding delay and
factory (address, runtime code digest, registrar and rotation delay) against
the reviewed manifest, and that the factory indexed this vault under its
project ID and token. `codeSha256` hashes decoded `eth_getCode` bytes,
including constructor immutables. The current manifest has one sponsor
address, so activation also requires the refund destination to equal that
owner.

## Events and ABI (v4)

```
ProjectEscrow
  Deposited(address indexed depositor, uint128 amount)
  AwardCommitted(bytes32 indexed id, uint64 indexed actorId, uint128 gross, uint128 fee, bytes32 sourceDigest)
  DestinationBound(uint64 indexed actorId, address indexed destination, uint64 version, bytes32 claimDigest, uint64 activatesAt)
  BindingCancelled(uint64 indexed actorId, uint64 version)
  Paid(bytes32 indexed id, uint64 indexed actorId, address indexed destination, uint64 version, uint128 gross, uint128 net, uint128 fee)
  UnusedWithdrawn(address indexed destination, uint128 gross, uint128 net, uint128 fee)
  ServiceCharged(bytes32 indexed invoiceDigest, uint128 amount)
  FeesClaimed(address indexed feeRecipient, uint128 amount)
  deposit(uint128) commitAward(bytes32,uint64,uint128,bytes32) withdrawUnused(uint128)
  chargeService(uint128,bytes32) pay(bytes32,uint64) claimFees() totals() decimals()
  payoutFee(uint128) = gross / 50   withdrawalFee(uint128) = payoutFee(gross)
EscrowFactory
  constructor(address registrar, address feeRecipient, address identityAuthority, uint64 bindingDelay)
  create(bytes32 projectId, address token, address owner, address refundDestination)
  vaults(bytes32 projectId, address token) vaultSalt(bytes32,address)
  VaultCreated(bytes32 indexed projectId, address indexed token, address indexed vault, address owner, address refundDestination, uint8 decimals)
```

The adapter exports the topics as `EVM_ESCROW_EVENT_TOPICS`, computed from
these signatures. For the full ABI, use `forge inspect ProjectEscrow abi`.

## Local validation

Use Foundry 1.7.1 (commit `4072e48705af9d93e3c0f6e29e93b5e9a40caed8`)
and the compiler pinned in `foundry.toml`. From the repository root:

```sh
forge fmt --root contracts/evm --check
forge build --root contracts/evm --sizes
forge test --root contracts/evm
bun contracts/evm/adapter.integration.ts
```

`forge test` runs the Foundry suites under `test/`. `test/AnyToken.t.sol`
covers 0-, 2-, 9- and 18-decimal tokens, amounts beyond `uint64`, `uint128`
overflow, permissionless deposit, the 2% withdrawal fee, fee-on-transfer
rejection, tokens without valid decimals, one vault per project and token, and
`totals()`. The invariant suite runs at 6 and 18 decimals with random
depositors. The suites also include regression tests for the
binding lifecycle (commit delay, payment frozen during a rotation and after its
cancel, cancel cap between payments, delay bounds, one-shot cancel), token and
accounting checks, and invariant runs over random owner, authority and payer
sequences. These suites are regression evidence, not a security review. The
`base` job in `.github/workflows/escrow-tests.yml` runs the format check, build
and `forge test` on every escrow change.

The integration deploys `integration/TestDollar.sol`, a six-decimal test
ERC-20, and `test/WideToken.sol` at 18 decimals with amounts beyond `uint64`. The test token is not Circle USDC; Circle integration, wallet signatures, OAuth, indexer finality,
and live broadcast require separate public-chain acceptance. The adapter integration
script starts an isolated Anvil on port 18546, executes actual deployment, award,
and payment transactions, and checks canonical finalized receipts plus rejection
of wrong chains, vaults, obligations, event indices, and nonfinalized receipts.

## Testnet deployment

Each checked-in script rejects every chain except its own. Every script reads
three public addresses from the environment: `ESCROW_REGISTRAR`,
`ESCROW_FEE_RECIPIENT` and `ESCROW_IDENTITY_AUTHORITY`. Each is required.
Only `DeployBase.s.sol` defaults `ESCROW_FEE_RECIPIENT` to Slop's published
Base fee recipient `0x8f77C37D8650776bFe73c9b12B15209eE15D9b86` when it is not
set. No script fixes a token: one factory serves every ERC-20 on its chain.
Supply a dedicated test-only external signer through Foundry's account or
hardware-wallet options. The signer only pays gas and holds no role. Do not put
a private key in a command, environment dump, source file, or evidence.

First simulate the exact compiled source:

```sh
cd contracts/evm
forge script script/DeployBaseSepolia.s.sol:DeployBaseSepolia \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --account slop-test-deployer
```

Use `DeployEthereumSepolia.s.sol:DeployEthereumSepolia` with
`$ETHEREUM_SEPOLIA_RPC_URL`, or follow
[`docs/robinhood-chain-testnet-runbook.md`](../../docs/robinhood-chain-testnet-runbook.md)
for Robinhood Chain Testnet. After the test deployment authority reviews the
simulation, the same invocation with `--broadcast` submits testnet
transactions. No public deployment was run as part of the local
implementation. Mainnet steps are in [`../DEPLOY-MAINNET.md`](../DEPLOY-MAINNET.md);
only humans run them. Keep transaction artifacts in ignored `broadcast/`, and
publish only reviewed safe deployment evidence.

Record the source SHA, compiler settings, factory address, deployment
transaction, chain ID, registrar and its custody, fee address, and identity
authority. Verify runtime bytecode and constructor configuration. Create each
vault from its reviewed project manifest with
`create(projectId, token, owner, owner)`, then verify its owner, refund
address, token, decimals, project ID, and authority. Export the ABI from
`forge inspect ProjectEscrow abi` as build output for the adapter; do not
maintain a handwritten second ABI. Run the full acceptance scenario with
actual test tokens and finalized receipts. Independent review, a rehearsed run
of the key recovery runbook on the test deployment, and public-chain evidence
remain launch gates.
