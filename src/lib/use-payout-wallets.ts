import type { SolanaSignMessageFeature } from "@solana/wallet-standard-features";
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletWithFeatures } from "@wallet-standard/base";
import type { StandardConnectFeature } from "@wallet-standard/features";
import { useEffect, useState } from "react";
import type { PaymentChain } from "./payments/contracts";

type EthereumWallet = {
  request(input: { method: string; params?: unknown[] }): Promise<unknown>;
  providers?: EthereumWallet[];
  isMetaMask?: boolean;
  isPhantom?: boolean;
  isCoinbaseWallet?: boolean;
};
type SolanaWallet = {
  connect(): Promise<{ publicKey: { toString(): string } }>;
  signMessage(
    message: Uint8Array,
    display: "utf8",
  ): Promise<{ signature: Uint8Array }>;
  isPhantom?: boolean;
  isSolflare?: boolean;
};
type WalletWindow = Window & {
  ethereum?: EthereumWallet;
  solana?: SolanaWallet;
  phantom?: { solana?: SolanaWallet };
};

export type PayoutWallet = {
  id: string;
  name: string;
  chain: PaymentChain;
  connect(): Promise<{
    address: string;
    sign(message: string): Promise<string>;
  }>;
};

function evmWallet(
  id: string,
  name: string,
  provider: EthereumWallet,
): PayoutWallet {
  return {
    id,
    name,
    chain: "base",
    async connect() {
      const addresses = await provider.request({
        method: "eth_requestAccounts",
      });
      if (!Array.isArray(addresses) || typeof addresses[0] !== "string")
        throw new Error("Your wallet did not return a Base address.");
      const address = addresses[0].toLowerCase();
      return {
        address,
        async sign(message) {
          const hex = `0x${Array.from(new TextEncoder().encode(message), (n) => n.toString(16).padStart(2, "0")).join("")}`;
          const signature = await provider.request({
            method: "personal_sign",
            params: [hex, address],
          });
          if (typeof signature !== "string")
            throw new Error("Your wallet did not return a signature.");
          return signature;
        },
      };
    },
  };
}

/** Discover without connecting. Only the user's chosen provider receives a request. */
export function usePayoutWallets(): PayoutWallet[] {
  const [choices, setChoices] = useState<PayoutWallet[]>([]);
  useEffect(() => {
    const browser = window as WalletWindow;
    const evm = new Map<string, PayoutWallet>();
    const solanaIds = new Map<Wallet, string>();
    const standard = getWallets();
    function update() {
      const next = [...evm.values()];
      // Legacy globals are fallback discovery only, never a preferred wallet.
      if (!evm.size && browser.ethereum) {
        const providers = browser.ethereum.providers ?? [browser.ethereum];
        [...new Set(providers)].forEach((provider, index) => {
          const name = provider.isPhantom
            ? "Phantom"
            : provider.isMetaMask
              ? "MetaMask"
              : provider.isCoinbaseWallet
                ? "Coinbase Wallet"
                : "Browser wallet";
          next.push(evmWallet(`legacy-evm-${index}`, name, provider));
        });
      }
      for (const wallet of standard.get()) {
        if (
          !wallet.chains.some((chain) => chain.startsWith("solana:")) ||
          !("standard:connect" in wallet.features) ||
          !("solana:signMessage" in wallet.features)
        )
          continue;
        const supported = wallet as WalletWithFeatures<
          StandardConnectFeature & SolanaSignMessageFeature
        >;
        if (!solanaIds.has(wallet))
          solanaIds.set(wallet, `solana-${solanaIds.size}`);
        next.push({
          id: solanaIds.get(wallet) as string,
          name: wallet.name,
          chain: "solana",
          async connect() {
            const { accounts } =
              await supported.features["standard:connect"].connect();
            const account = accounts.find(
              (a) =>
                a.chains.some((chain) => chain.startsWith("solana:")) &&
                a.features.includes("solana:signMessage"),
            );
            if (!account)
              throw new Error(
                "Your wallet did not return a Solana account that can sign messages.",
              );
            return {
              address: account.address,
              async sign(message) {
                const bytes = new TextEncoder().encode(message);
                const [result] = await supported.features[
                  "solana:signMessage"
                ].signMessage({ account, message: bytes });
                if (
                  !result ||
                  result.signedMessage.length !== bytes.length ||
                  result.signedMessage.some(
                    (byte, index) => byte !== bytes[index],
                  )
                )
                  throw new Error(
                    "Your wallet changed the confirmation message. Please use a wallet that signs the exact message.",
                  );
                return btoa(String.fromCharCode(...result.signature));
              },
            };
          },
        });
      }
      if (!next.some((wallet) => wallet.chain === "solana")) {
        const legacy = [...new Set([browser.phantom?.solana, browser.solana])];
        legacy.forEach((provider, index) => {
          if (!provider) return;
          next.push({
            id: `legacy-solana-${index}`,
            name:
              provider === browser.phantom?.solana || provider.isPhantom
                ? "Phantom"
                : provider.isSolflare
                  ? "Solflare"
                  : "Browser wallet",
            chain: "solana",
            async connect() {
              const { publicKey } = await provider.connect();
              return {
                address: publicKey.toString(),
                async sign(message) {
                  const result = await provider.signMessage(
                    new TextEncoder().encode(message),
                    "utf8",
                  );
                  return btoa(String.fromCharCode(...result.signature));
                },
              };
            },
          });
        });
      }
      setChoices(next);
    }
    function announce(event: Event) {
      const detail = (event as CustomEvent).detail;
      if (
        typeof detail?.info?.uuid !== "string" ||
        typeof detail.info.name !== "string" ||
        typeof detail?.provider?.request !== "function"
      )
        return;
      if (!evm.has(detail.info.uuid))
        evm.set(
          detail.info.uuid,
          evmWallet(
            `evm-${detail.info.uuid}`,
            detail.info.name,
            detail.provider,
          ),
        );
      update();
    }
    const offRegister = standard.on("register", update);
    const offUnregister = standard.on("unregister", update);
    window.addEventListener("eip6963:announceProvider", announce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    update();
    return () => {
      offRegister();
      offUnregister();
      window.removeEventListener("eip6963:announceProvider", announce);
    };
  }, []);
  return choices;
}
