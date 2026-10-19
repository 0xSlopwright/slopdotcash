# Escrow mainnet deployment (humans only)

These are the exact human steps to deploy the escrow v4 `EscrowFactory` on
Base, Robinhood Chain and Ethereum, to verify its source, and to upgrade the
Solana program to the current source and make it immutable.

**Agents must not run any step in this file.** Agents never hold mainnet keys,
never sign, and never broadcast. An agent may prepare a command or review a
simulation output that a human gives it.

No project activates escrow because a factory or program exists. Activation
needs a reviewed manifest revision with the deployment evidence below
(`src/lib/escrow-policy.mjs`, `assertEscrowPolicy`).

## 0. Before any network

1. Check out the reviewed commit of `main`. Record its SHA. Run
   `git status` and confirm a clean tree.
2. Confirm that independent review, the testnet acceptance runs
   (`docs/robinhood-chain-testnet-runbook.md` and the Base Sepolia run) and a
   rehearsed key recovery runbook are recorded. These are launch gates.
3. Decide and record, for each chain, three public addresses and their
   custody:
   - `ESCROW_REGISTRAR`: creates vaults and proposes identity authority
     rotations. Use a reviewed multisig or hardware key, never the attester
     service key.
   - `ESCROW_IDENTITY_AUTHORITY`: Slop's attester key (PAY-05).
   - `ESCROW_FEE_RECIPIENT`: the network fee wallet. On Base the script
     defaults to Slop's published Base fee recipient
     `0x8f77C37D8650776bFe73c9b12B15209eE15D9b86` when this variable is not
     set. On every other chain it is required.
4. The deployer account pays gas only and holds no escrow role. Use a hardware
   wallet (`--ledger` or `--trezor`) or a Foundry keystore (`--account`).
   Never pass a private key on the command line.
5. Use Foundry 1.7.1 (commit `4072e48705af9d93e3c0f6e29e93b5e9a40caed8`).
   Build and test the exact tree:

   ```sh
   cd contracts/evm
   forge fmt --check
   forge build --sizes
   forge test
   ```

## 1. EVM factory deployment (Base, Robinhood Chain, Ethereum)

| Network | Chain id | Script | RPC variable |
| --- | --- | --- | --- |
| Base | 8453 | `script/DeployBase.s.sol:DeployBase` | `BASE_RPC_URL` |
| Robinhood Chain | 4663 | `script/DeployRobinhood.s.sol:DeployRobinhood` | `ROBINHOOD_RPC_URL` |
| Ethereum | 1 | `script/DeployEthereum.s.sol:DeployEthereum` | `ETHEREUM_RPC_URL` |

Each script rejects every other chain id and reverts when a required address
is missing. One factory serves every standard ERC-20 on its chain; the
registrar later creates one vault per project and token.

### 1.1 Robinhood Chain only: opcode check

The compiled contracts use `MCOPY` (Cancun). Read the ArbOS version first:

```sh
cast chain-id --rpc-url "$ROBINHOOD_RPC_URL"                  # 4663
cast call 0x0000000000000000000000000000000000000064 \
  'arbOSVersion()(uint256)' --rpc-url "$ROBINHOOD_RPC_URL"    # must be >= 75
```

`arbOSVersion()` returns 55 plus the ArbOS version; ArbOS 20 added `MCOPY`.
Stop if the value is below 75. Record the value and block.

### 1.2 Simulate

```sh
cd contracts/evm
export ESCROW_REGISTRAR=0x...
export ESCROW_IDENTITY_AUTHORITY=0x...
export ESCROW_FEE_RECIPIENT=0x...      # optional on Base only
forge script script/DeployEthereum.s.sol:DeployEthereum \
  --rpc-url "$ETHEREUM_RPC_URL" --ledger --sender 0xYourDeployer
```

Replace the script and RPC for Base or Robinhood Chain. Read the simulated
`FactoryDeployed` event: chain id, registrar, identity authority, fee
recipient, and `bindingDelay = 172800`. A second person checks each address
against the recorded decision.

### 1.3 Broadcast

Run the same command with `--broadcast`. Keep the `broadcast/` artifacts out of
git. Record the factory address and the deployment transaction hash.

### 1.4 Verify the deployed factory

```sh
FACTORY=0x...
RPC="$ETHEREUM_RPC_URL"
cast call "$FACTORY" 'registrar()(address)' --rpc-url "$RPC" --block finalized
cast call "$FACTORY" 'identityAuthority()(address)' --rpc-url "$RPC" --block finalized
cast call "$FACTORY" 'feeRecipient()(address)' --rpc-url "$RPC" --block finalized
cast call "$FACTORY" 'bindingDelay()(uint64)' --rpc-url "$RPC" --block finalized
cast call "$FACTORY" 'AUTHORITY_ROTATION_DELAY()(uint64)' --rpc-url "$RPC" --block finalized
cast code "$FACTORY" --rpc-url "$RPC" --block finalized | xxd -r -p | shasum -a 256
```

Deploy the same build with the same constructor arguments on a local Anvil and
compare the runtime code SHA-256. The digest is the manifest's
`factoryCodeSha256`.

### 1.5 Source verification

```sh
ARGS=$(cast abi-encode 'constructor(address,address,address,uint64)' \
  "$ESCROW_REGISTRAR" "$ESCROW_FEE_RECIPIENT" "$ESCROW_IDENTITY_AUTHORITY" 172800)
forge verify-contract "$FACTORY" src/ProjectEscrow.sol:EscrowFactory \
  --chain-id 1 --constructor-args "$ARGS" --watch \
  --verifier etherscan --etherscan-api-key "$ETHERSCAN_API_KEY"
```

- Base: `--chain-id 8453`, Etherscan v2 API key (Basescan).
- Ethereum: `--chain-id 1`.
- Robinhood Chain: `--chain-id 4663 --verifier blockscout --verifier-url
  https://robinhoodchain.blockscout.com/api/`.

`foundry.toml` pins solc 0.8.30, `evm_version = "cancun"`, optimizer 200 runs
and `bytecode_hash = "none"`; the verifier reads them from the project.

### 1.6 Each vault

For each reviewed project manifest the registrar sends:

```sh
cast send "$FACTORY" 'create(bytes32,address,address,address)' \
  "$PROJECT_ID" "$TOKEN" "$OWNER" "$OWNER" --rpc-url "$RPC" --ledger
VAULT=$(cast call "$FACTORY" 'vaults(bytes32,address)(address)' "$PROJECT_ID" "$TOKEN" --rpc-url "$RPC")
```

Before you create a vault, check that the token is a standard ERC-20 with
exact transfers: no fee on transfer, no rebasing. Read `decimals()` and record
it. After creation, verify the vault source like the factory (the constructor
arguments are `projectId, token, owner, refundDestination, feeRecipient,
bindingDelay`), record its runtime code SHA-256 as `codeSha256`, and run
`verifyEvmDeployment` from `contracts/evm/adapter.ts` against the manifest
before activation.

### 1.7 EVM evidence

Record: source SHA, Foundry version, chain id, ArbOS version (Robinhood
Chain), deployer, registrar and custody, identity authority and custody, fee
recipient, factory address, deployment transaction, `factoryCodeSha256`, local
Anvil digest, explorer verification link, and for each vault its project ID,
token, decimals, creation transaction and `codeSha256`.

## 2. Solana program upgrade and finalization

The Solana section is below.
