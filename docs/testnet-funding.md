# Check test gas

Run the read-only funding check with the intended public address:

```sh
node scripts/check-payout-test-funding.mjs base-sepolia "$BASE_TEST_ADDRESS"
node scripts/check-payout-test-funding.mjs solana-devnet "$SOLANA_TEST_ADDRESS"
node scripts/check-payout-test-funding.mjs solana-testnet "$SOLANA_TEST_ADDRESS"
node scripts/check-payout-test-funding.mjs robinhood-testnet "$ROBINHOOD_TEST_ADDRESS"
```

An optional third argument selects an HTTPS RPC URL. Prefer a public URL without
credentials. If a network needs an archive endpoint that carries a key, keep
the key out of shell history and recorded evidence: build the URL from an
environment variable and redact it in any output you keep. The command checks
the EVM chain id or Solana genesis hash before reading a finalized balance.
Mainnet network names are rejected. It neither reads signing keys nor requests
funds, signs, or broadcasts a transaction.

Robinhood Chain Testnet (chain id 46630) gas comes from
`https://faucet.testnet.chain.robinhood.com`. The check reads the chain id
`0xb626` and then the balance at the `finalized` tag. The public RPC
`https://rpc.testnet.chain.robinhood.com` answers the chain id but does not
keep account state at `finalized` (it replies `historical state is not available`, which is an RPC limitation, not a zero balance), so pass an archive
RPC URL for Robinhood Chain Testnet as the third argument for this network.
Alchemy is the provider the Robinhood documentation names. The public RPC
remains acceptable for a one-off deployment broadcast, not for this check and
not for the scanner.

JSON output reports the integer balance as a decimal string (`wei` or
`lamports`), the finalized block or slot, and `nonzero`. A zero balance is a
successful observation, not an RPC error. Exit code 1 means the check failed;
do not treat that result as zero or funded. A nonzero balance proves gas is
present but does not prove it covers deployment costs. This command does not
check test USDC or other token balances.

For a later funding recheck, rerun the same command with the same public address
and network. Never change addresses to evade faucet cooldowns or verification.

Solana deployment also needs program and buffer rent. Budget approximately
6 SOL for a deployment rehearsal, then confirm the current rent and transaction
estimate before deployment. A few lamports do not meet that budget. Devnet USDC
is a separate token; Solana testnet uses an explicitly reviewed custom test mint
because it has no canonical Circle USDC faucet asset.
