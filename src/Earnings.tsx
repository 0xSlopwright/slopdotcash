import { useEffect, useId, useRef, useState } from "react";
import { readBoundedJson } from "./lib/browser-json";
import {
  type PaymentChain,
  type PaymentsAccount,
  transactionUrl,
} from "./lib/payments/contracts";
import { isDirectTransfer } from "./lib/use-direct-transfers";
import { usePayoutWallets } from "./lib/use-payout-wallets";
import { formatDate, formatDateTime } from "./Presentation";

const networkName = { base: "Base", solana: "Solana" };

const networkLabels: Record<string, string> = {
  "base-mainnet": "Base · USDC",
  "base-sepolia": "Base Sepolia · test USDC",
  "solana-mainnet": "Solana · USDC",
  "solana-devnet": "Solana Devnet · test USDC",
  "solana-testnet": "Solana Testnet · test token",
  anvil: "Local Base test · test USDC",
};
function amount(value: string): string {
  const number = BigInt(value);
  const fraction = (number % 1_000_000n)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return `${(number / 1_000_000n).toLocaleString()}${fraction ? `.${fraction}` : ""} USDC`;
}

class SignedOutError extends Error {}

async function request(path: string, body?: unknown, signal?: AbortSignal) {
  const response = await fetch(`/api/v1/payments/${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000),
  });
  if (response.status === 401) throw new SignedOutError();
  if (!response.ok) {
    if (response.status === 409)
      throw new Error(
        "Your wallet changed. Refresh and confirm the current address.",
      );
    throw new Error(
      "The payment service is unavailable. Your recorded awards are unchanged. Please retry.",
    );
  }
  return readBoundedJson(response, 1_048_576, "payment account");
}

function account(value: unknown): PaymentsAccount {
  if (!value || typeof value !== "object")
    throw new Error("Invalid payment account response.");
  const data = value as PaymentsAccount;
  const money = (v: unknown) =>
    typeof v === "string" && /^(0|[1-9]\d*)$/.test(v);
  if (
    typeof data.githubUserId !== "string" ||
    !/^\d+$/.test(data.githubUserId) ||
    !Array.isArray(data.wallets) ||
    !Array.isArray(data.payments) ||
    !Array.isArray(data.balances) ||
    data.wallets.some(
      (w) =>
        !w ||
        !["base", "solana"].includes(w.chain) ||
        typeof w.claimId !== "string" ||
        typeof w.address !== "string" ||
        typeof w.authorized !== "boolean",
    ) ||
    data.payments.some(
      (p) =>
        !p ||
        !["base", "solana"].includes(p.chain) ||
        typeof p.projectId !== "string" ||
        typeof p.network !== "string" ||
        (p.transactionId !== null && typeof p.transactionId !== "string") ||
        (p.state === "paid" && !p.transactionId) ||
        typeof p.id !== "string" ||
        !money(p.grossMicro) ||
        !money(p.netMicro) ||
        !money(p.feeMicro) ||
        BigInt(p.grossMicro) !== BigInt(p.netMicro) + BigInt(p.feeMicro) ||
        !["reserved", "paid"].includes(p.state) ||
        ![
          "needs_wallet",
          "awaiting_binding",
          "submitted",
          "held",
          "paid",
        ].includes(p.deliveryState),
    ) ||
    data.balances.some(
      (b) => !b || !["base", "solana"].includes(b.chain) || !money(b.netMicro),
    ) ||
    !Array.isArray(data.directTransfers) ||
    !data.directTransfers.every(isDirectTransfer) ||
    !Array.isArray(data.walletObservations) ||
    data.walletObservations.some(
      (o) =>
        !o ||
        !["base", "solana"].includes(o.chain) ||
        typeof o.address !== "string" ||
        o.proofLevel !== "profile_readme" ||
        !/^https:\/\/github\.com\//u.test(o.sourceUrl) ||
        Number.isNaN(Date.parse(o.observedAt)),
    )
  )
    throw new Error("The payment record could not be verified. Please retry.");
  return data;
}

export function EarningsPage() {
  const wallets = usePayoutWallets();
  const [selected, setSelected] = useState({ base: "", solana: "" });
  const [data, setData] = useState<PaymentsAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [signedOut, setSignedOut] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<PaymentChain | null>(null);
  const [revision, setRevision] = useState(0);
  const refresh = () => setRevision((n) => n + 1);
  const mounted = useRef(true);
  const heading = useId();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a user refresh must reload the account.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    request("me", undefined, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setSignedOut(false);
          setData(account(value));
        }
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        if (e instanceof SignedOutError) {
          setSignedOut(true);
          setData(null);
        } else
          setError(
            e instanceof Error ? e.message : "Could not load your payouts.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [revision]);

  async function connect(chain: PaymentChain) {
    setBusy(chain);
    setError("");
    setMessage("");
    try {
      const chosen = wallets.find(
        (wallet) => wallet.chain === chain && wallet.id === selected[chain],
      );
      if (!chosen)
        throw new Error(`Choose a ${networkName[chain]} wallet first.`);
      const { address, sign } = await chosen.connect();
      const claim = (await request("wallets/register", { chain, address })) as {
        claimId: string;
      };
      if (typeof claim.claimId !== "string")
        throw new Error("Wallet registration could not be verified.");
      const challenge = (await request("wallets/challenge", {
        claimId: claim.claimId,
      })) as {
        challengeId: string;
        message: string;
        address: string;
        chain: string;
      };
      if (
        challenge.address !== address ||
        challenge.chain !== chain ||
        typeof challenge.challengeId !== "string" ||
        typeof challenge.message !== "string"
      )
        throw new Error(
          "Wallet confirmation does not match your selected address.",
        );
      const signature = await sign(challenge.message);
      await request("wallets/authorize", {
        claimId: claim.claimId,
        challengeId: challenge.challengeId,
        signature,
      });
      if (mounted.current) {
        setMessage(
          `${networkName[chain]} wallet confirmed. Eligible unpaid awards will be sent automatically. Wallet changes wait at least 24 hours and any earlier payment must be reconciled first.`,
        );
        refresh();
      }
    } catch (e) {
      if (!mounted.current) return;
      if (e instanceof SignedOutError) {
        setSignedOut(true);
        setData(null);
      } else
        setError(
          e instanceof Error
            ? e.message
            : "Wallet confirmation failed. Please retry.",
        );
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  return (
    <main className="shell route-main earnings-page" aria-labelledby={heading}>
      <h1 id={heading}>Your payouts</h1>
      <p>
        This page shows escrow payouts after the 2% fee deduction. Legacy
        project cycles keep their recorded fee policy.
      </p>
      {loading && <p role="status">Checking your payouts…</p>}
      {signedOut && !loading && (
        <div>
          <p>Sign in with GitHub to view your payouts.</p>
          <a className="button" href="/login?next=earnings">
            Sign in with GitHub
          </a>
        </div>
      )}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button type="button" onClick={refresh}>
            Retry
          </button>
        </div>
      )}
      {message && <p role="status">{message}</p>}
      {data && (
        <>
          {error && <p>Showing the last verified account response.</p>}
          <section aria-label="Payout wallets" className="earnings-wallets">
            {(["base", "solana"] as const).map((chain) => {
              const wallet = data.wallets.find((w) => w.chain === chain);
              const balance =
                data.balances.find((b) => b.chain === chain)?.netMicro ?? "0";
              return (
                <article key={chain} className="funding-workbench">
                  <h2>{networkName[chain]}</h2>
                  <p>
                    <strong>{amount(balance)}</strong> unpaid
                  </p>
                  {wallet ? (
                    <p className="wallet-address">{wallet.address}</p>
                  ) : (
                    <p>
                      Add a {networkName[chain]} wallet to receive awards on
                      this network.
                    </p>
                  )}
                  {!wallet?.authorized &&
                    data.walletObservations
                      .filter(
                        (o) =>
                          o.chain === chain && o.address !== wallet?.address,
                      )
                      .slice(0, 1)
                      .map((o) => (
                        <p key={o.sourceUrl}>
                          Your{" "}
                          <a
                            href={o.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            GitHub profile README
                          </a>{" "}
                          listed{" "}
                          <span className="wallet-address">{o.address}</span> on{" "}
                          {formatDate(o.observedAt)}. That record is history
                          only. Connect and confirm a wallet to receive escrow
                          payments.
                        </p>
                      ))}
                  {wallet && (
                    <p>
                      {wallet.authorized
                        ? "Confirmed for automatic payments"
                        : "Confirm this wallet to enable automatic payments"}
                    </p>
                  )}
                  {wallet?.activationEligibleAt &&
                    Date.parse(wallet.activationEligibleAt) > Date.now() && (
                      <p>
                        Wallet change becomes eligible after{" "}
                        {formatDateTime(wallet.activationEligibleAt)}. Existing
                        awards remain reserved.
                      </p>
                    )}
                  <label>
                    {networkName[chain]} wallet
                    <select
                      value={selected[chain]}
                      disabled={busy !== null}
                      onChange={(event) =>
                        setSelected((previous) => ({
                          ...previous,
                          [chain]: event.target.value,
                        }))
                      }
                    >
                      <option value="">Choose a wallet</option>
                      {wallets
                        .filter((choice) => choice.chain === chain)
                        .map((choice) => (
                          <option key={choice.id} value={choice.id}>
                            {choice.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  {!wallets.some((choice) => choice.chain === chain) && (
                    <p>
                      No {networkName[chain]} wallet detected. Enable a
                      compatible browser extension or open this page in your
                      wallet’s browser.
                    </p>
                  )}
                  <button
                    className="button secondary-button"
                    type="button"
                    disabled={
                      busy !== null ||
                      !wallets.some(
                        (choice) =>
                          choice.chain === chain &&
                          choice.id === selected[chain],
                      )
                    }
                    onClick={() => void connect(chain)}
                  >
                    {busy === chain
                      ? "Confirm in your wallet…"
                      : `${wallet?.authorized ? "Change" : "Connect"} ${networkName[chain]} wallet`}
                  </button>
                </article>
              );
            })}
          </section>
          <p>
            Payments publish your destination on chain. Wallet confirmation
            authorizes that address to receive your awards; it does not transfer
            funds from your wallet.
          </p>
          <section aria-labelledby={`${heading}-payments`}>
            <h2 id={`${heading}-payments`}>Payment history</h2>
            <button
              className="button secondary-button"
              type="button"
              onClick={refresh}
              disabled={loading}
            >
              Refresh payments
            </button>
            {data.payments.length === 0 ? (
              <p>
                No funded escrow awards yet. Proposed rewards appear on project
                pages until they are approved and funded.
              </p>
            ) : (
              <section
                className="points-table"
                aria-label="Payment history details; scroll horizontally for all columns"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll the payment history on narrow screens.
                tabIndex={0}
              >
                <table>
                  <caption>
                    Approved, funded awards and verified payments
                  </caption>
                  <thead>
                    <tr>
                      <th>Project</th>
                      <th>Network</th>
                      <th>Gross award</th>
                      <th>Fee</th>
                      <th>You receive</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.payments.map((payment) => (
                      <tr key={payment.id}>
                        <td>
                          <a
                            href={`/projects/${encodeURIComponent(payment.projectId)}`}
                          >
                            {payment.projectId}
                          </a>
                        </td>
                        <td>
                          {networkLabels[payment.network] ?? payment.network}
                        </td>
                        <td>{amount(payment.grossMicro)}</td>
                        <td>{amount(payment.feeMicro)}</td>
                        <td>{amount(payment.netMicro)}</td>
                        <td>
                          {
                            {
                              paid: "Paid, verified on chain",
                              needs_wallet: `Add or confirm ${networkName[payment.chain]} wallet`,
                              awaiting_binding: "Awaiting automatic payment",
                              submitted:
                                "Submitted, waiting for chain verification",
                              held: "Payment held, funds remain reserved",
                            }[payment.deliveryState]
                          }
                          {transactionUrl(
                            payment.network,
                            payment.transactionId,
                          ) && (
                            <p>
                              <a
                                href={
                                  transactionUrl(
                                    payment.network,
                                    payment.transactionId,
                                  ) ?? undefined
                                }
                                target="_blank"
                                rel="noreferrer"
                              >
                                View verified transaction
                              </a>
                            </p>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}
          </section>
          {data.directTransfers.length > 0 && (
            <section aria-labelledby={`${heading}-direct`}>
              <h2 id={`${heading}-direct`}>Sent outside escrow</h2>
              <p>
                A project creator sent these transfers directly, before escrow
                payouts. Each one is in a published disclosure and on chain. No
                payout fee was deducted.
              </p>
              <section
                className="points-table"
                aria-label="Direct payment details; scroll horizontally for all columns"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll the payment history on narrow screens.
                tabIndex={0}
              >
                <table>
                  <caption>Direct transfers by contribution month</caption>
                  <thead>
                    <tr>
                      <th>Project</th>
                      <th>Month</th>
                      <th>Network</th>
                      <th>Received</th>
                      <th>Transaction</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.directTransfers.map((t) => (
                      <tr key={`${t.network}:${t.transactionId}`}>
                        <td>
                          <a
                            href={`/projects/${encodeURIComponent(t.projectId)}`}
                          >
                            {t.projectId}
                          </a>
                        </td>
                        <td>{t.contributionMonth}</td>
                        <td>{networkLabels[t.network] ?? t.network}</td>
                        <td>{amount(t.amountMicro)}</td>
                        <td>
                          {transactionUrl(t.network, t.transactionId) ? (
                            <a
                              href={
                                transactionUrl(t.network, t.transactionId) ??
                                undefined
                              }
                              target="_blank"
                              rel="noreferrer"
                            >
                              View transfer
                            </a>
                          ) : (
                            t.transactionId
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            </section>
          )}
        </>
      )}
    </main>
  );
}
