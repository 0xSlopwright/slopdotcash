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
/** One EIP-6963 announcement, kept so a later announcement can be compared. */
type Announcement = {
  provider: EthereumWallet;
  name: string;
  rdns: string;
  icon: string;
};

export type PayoutWallet = {
  id: string;
  name: string;
  icon?: string;
  chain: PaymentChain;
  connect(): Promise<{
    address: string;
    sign(message: string): Promise<string>;
  }>;
};

// EIP-6963 requires a UUIDv4 for each provider announcement.
const uuidV4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const conflictMessage =
  "This wallet announced conflicting details. Reload the page and check your wallet extensions before you connect.";

function evmWallet(
  id: string,
  name: string,
  provider: EthereumWallet,
  trusted: () => boolean,
  icon?: string,
): PayoutWallet {
  return {
    id,
    name,
    icon,
    chain: "base",
    async connect() {
      if (!trusted()) throw new Error(conflictMessage);
      const addresses = await provider.request({
        method: "eth_requestAccounts",
      });
      if (!Array.isArray(addresses) || typeof addresses[0] !== "string")
        throw new Error("Your wallet did not return a Base address.");
      const address = addresses[0].toLowerCase();
      return {
        address,
        async sign(message) {
          if (!trusted()) throw new Error(conflictMessage);
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

function legacyEvmName(provider: EthereumWallet) {
  return provider.isPhantom
    ? "Phantom"
    : provider.isMetaMask
      ? "MetaMask"
      : provider.isCoinbaseWallet
        ? "Coinbase Wallet"
        : "Browser wallet";
}

function legacySolanaName(provider: SolanaWallet, browser: WalletWindow) {
  return provider === browser.phantom?.solana || provider.isPhantom
    ? "Phantom"
    : provider.isSolflare
      ? "Solflare"
      : "Browser wallet";
}

/** Discover without connecting. Only the user's chosen provider receives a request. */
export function usePayoutWallets(): PayoutWallet[] {
  const [choices, setChoices] = useState<PayoutWallet[]>([]);
  useEffect(() => {
    const browser = window as WalletWindow;
    const announced = new Map<string, Announcement>();
    // A UUID that announces a different provider or different details is
    // blocked for this page load. Every provider object in that conflict is
    // blocked too, so the legacy global cannot offer it again.
    const conflictedIds = new Set<string>();
    const conflictedProviders = new Set<EthereumWallet>();
    const evm = new Map<string, PayoutWallet>();
    const solanaIds = new Map<Wallet, string>();
    const standard = getWallets();
    function update() {
      const next = [...evm]
        .filter(
          ([uuid]) =>
            !conflictedProviders.has(
              (announced.get(uuid) as Announcement).provider,
            ),
        )
        .map(([, wallet]) => wallet);
      // Legacy globals add only providers that no EIP-6963 announcement
      // already offers. Object identity decides; a name never hides a wallet.
      const announcedProviders = new Set(
        [...announced.values()].map((entry) => entry.provider),
      );
      if (browser.ethereum) {
        const providers = browser.ethereum.providers ?? [browser.ethereum];
        [...new Set(providers)].forEach((provider, index) => {
          if (
            announcedProviders.has(provider) ||
            conflictedProviders.has(provider)
          )
            return;
          next.push(
            evmWallet(
              `legacy-evm-${index}`,
              legacyEvmName(provider),
              provider,
              () => !conflictedProviders.has(provider),
            ),
          );
        });
      }
      const standardNames = new Set<string>();
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
        standardNames.add(wallet.name.toLowerCase());
        next.push({
          id: solanaIds.get(wallet) as string,
          name: wallet.name,
          icon: wallet.icon,
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
      // A Wallet Standard wallet is a different object from the legacy global
      // that the same extension injects, so identity cannot match them. A
      // legacy global stays available unless a Wallet Standard wallet with the
      // same detected name already offers it.
      const legacy = [...new Set([browser.phantom?.solana, browser.solana])];
      legacy.forEach((provider, index) => {
        if (!provider) return;
        const name = legacySolanaName(provider, browser);
        if (standardNames.has(name.toLowerCase())) return;
        next.push({
          id: `legacy-solana-${index}`,
          name,
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
      setChoices(next);
    }
    function announce(event: Event) {
      const detail = (event as CustomEvent).detail;
      const info = detail?.info;
      const provider = detail?.provider;
      if (
        typeof info?.uuid !== "string" ||
        !uuidV4.test(info.uuid) ||
        typeof info.name !== "string" ||
        !info.name.trim() ||
        typeof info.rdns !== "string" ||
        typeof info.icon !== "string" ||
        typeof provider?.request !== "function"
      )
        return;
      const uuid = info.uuid.toLowerCase();
      if (conflictedIds.has(uuid)) {
        conflictedProviders.add(provider);
        update();
        return;
      }
      const previous = announced.get(uuid);
      if (previous) {
        // A genuine reannouncement repeats the same provider and details.
        if (
          previous.provider === provider &&
          previous.name === info.name &&
          previous.rdns === info.rdns &&
          previous.icon === info.icon
        )
          return;
        conflictedIds.add(uuid);
        conflictedProviders.add(previous.provider);
        conflictedProviders.add(provider);
        evm.delete(uuid);
        update();
        return;
      }
      announced.set(uuid, {
        provider,
        name: info.name,
        rdns: info.rdns,
        icon: info.icon,
      });
      evm.set(
        uuid,
        evmWallet(
          `evm-${uuid}`,
          info.name,
          provider,
          () => !conflictedIds.has(uuid) && !conflictedProviders.has(provider),
          info.icon,
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
