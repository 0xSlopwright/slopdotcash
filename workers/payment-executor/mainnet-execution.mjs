/**
 * Reviewed per-network switch for mainnet payout execution. A mainnet network
 * executes payouts only when its value here is exactly `true`. Every value
 * stays `false` until a reviewed pull request records that network's
 * production activation: signer custody, verified deployment and monitoring.
 * Test networks do not use this switch. A network that is not listed is
 * rejected.
 */
export const MAINNET_EXECUTION = Object.freeze({
  "base-mainnet": false,
  ethereum: false,
  "robinhood-mainnet": false,
  "solana-mainnet": false,
});

export function mainnetExecutionEnabled(network) {
  return (
    Object.hasOwn(MAINNET_EXECUTION, network) &&
    MAINNET_EXECUTION[network] === true
  );
}
