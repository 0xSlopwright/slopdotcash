/** Provider/API fixtures exercise the real page; they never register a real wallet. */
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

const evmAddress = "0x1111111111111111111111111111111111111111";
const solanaAddress = "11111111111111111111111111111111";

async function payments(page: Page) {
  const writes: { path: string; body: Record<string, string> }[] = [];
  let claim = { chain: "base", address: evmAddress };
  await page.route("**/api/v1/payments/**", async (route) => {
    const path = new URL(route.request().url()).pathname.split("/payments/")[1];
    if (path === "me") {
      await route.fulfill({
        json: {
          githubUserId: "123",
          wallets: [],
          payments: [],
          balances: [],
          directTransfers: [],
          walletObservations: [],
        },
      });
      return;
    }
    const body = route.request().postDataJSON();
    writes.push({ path, body });
    if (path === "wallets/register") claim = body;
    await route.fulfill({
      json:
        path === "wallets/register"
          ? { claimId: "fixture" }
          : path === "wallets/challenge"
            ? {
                ...claim,
                challengeId: "fixture-challenge",
                message: "Fixture payout routing confirmation",
              }
            : {},
    });
  });
  return writes;
}

async function providers(page: Page, reject = false) {
  await page.addInitScript(
    ({ reject, evmAddress, solanaAddress }) => {
      const calls: string[] = [];
      const evm = (name: string) => ({
        request: async ({ method }: { method: string }) => {
          calls.push(`${name}:${method}`);
          if (reject) throw new Error("Wallet request rejected by user.");
          return method === "eth_requestAccounts"
            ? [evmAddress]
            : "0xfixture-signature";
        },
      });
      const metamask = evm("MetaMask");
      const phantom = evm("Phantom");
      const announce = () => {
        for (const [provider, name, uuid] of [
          [phantom, "Phantom", "0b7c3a8e-5f1d-4c2a-9e6b-3d4f5a6b7c80"],
          [metamask, "MetaMask", "6f9e2d1c-8b7a-4e3d-a2c1-0f9e8d7c6b5a"],
        ] as const)
          window.dispatchEvent(
            new CustomEvent("eip6963:announceProvider", {
              detail: {
                provider,
                info: {
                  uuid,
                  name,
                  rdns: `${name}.app`,
                  icon: "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22/%3E",
                },
              },
            }),
          );
      };
      Object.assign(window, { ethereum: phantom, walletCalls: calls });
      window.addEventListener("eip6963:requestProvider", announce);
      const account = {
        address: solanaAddress,
        publicKey: new Uint8Array(32),
        chains: ["solana:mainnet"],
        features: ["solana:signMessage"],
      };
      const solana = (name: string) => ({
        name,
        version: "1.0.0",
        icon: "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22/%3E",
        chains: ["solana:mainnet"],
        accounts: [],
        features: {
          "standard:connect": {
            version: "1.0.0",
            connect: async () => {
              calls.push(`${name}:connect`);
              return { accounts: [account] };
            },
          },
          "solana:signMessage": {
            version: "1.0.0",
            signMessage: async ({ message }: { message: Uint8Array }) => {
              calls.push(`${name}:signMessage`);
              return [
                { signedMessage: message, signature: new Uint8Array(64) },
              ];
            },
          },
        },
      });
      window.addEventListener("wallet-standard:app-ready", (event) => {
        const api = (event as CustomEvent).detail;
        api.register(solana("Phantom"));
        const remove = api.register(solana("Backpack"));
        Object.assign(window, { removeBackpack: remove });
      });
      Object.assign(window, {
        announceWallets: announce,
        // Reuses MetaMask's UUID for a different provider object.
        announceImpostor: () =>
          window.dispatchEvent(
            new CustomEvent("eip6963:announceProvider", {
              detail: {
                provider: evm("Impostor"),
                info: {
                  uuid: "6f9e2d1c-8b7a-4e3d-a2c1-0f9e8d7c6b5a",
                  name: "MetaMask",
                  rdns: "MetaMask.app",
                  icon: "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22/%3E",
                },
              },
            }),
          ),
      });
    },
    { reject, evmAddress, solanaAddress },
  );
}

async function openPicker(
  page: Page,
  chain: "Base" | "Solana" | "Robinhood Chain",
) {
  await page
    .getByRole("button", { name: `Connect ${chain} wallet`, exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: `Connect a ${chain} wallet`,
  });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("modal routes Base and Robinhood Chain to MetaMask and Solana to Backpack despite Phantom globals", async ({
  page,
}, info) => {
  const writes = await payments(page);
  await providers(page);
  await page.goto("/earnings");
  expect(
    await page.evaluate(
      () => (window as unknown as { walletCalls: string[] }).walletCalls,
    ),
  ).toEqual([]);
  const base = await openPicker(page, "Base");
  await expect(
    base.getByRole("button", { name: "Backpack Detected" }),
  ).toHaveCount(0);
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(axe.violations).toEqual([]);
  await page.screenshot({
    path: info.outputPath("wallet-modal.png"),
    fullPage: true,
  });
  await base
    .getByRole("button", { name: "MetaMask Detected", exact: true })
    .click();
  await expect(base).not.toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "Base wallet confirmed" }),
  ).toBeVisible();
  const solana = await openPicker(page, "Solana");
  await solana
    .getByRole("button", { name: "Backpack Detected", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Solana wallet confirmed" }),
  ).toBeVisible();
  // Robinhood Chain is an EVM chain: the picker offers the EVM wallets only,
  // and the claim is registered for chain robinhood, separate from Base.
  const robinhood = await openPicker(page, "Robinhood Chain");
  await expect(
    robinhood.getByRole("button", { name: "Backpack Detected" }),
  ).toHaveCount(0);
  await robinhood
    .getByRole("button", { name: "MetaMask Detected", exact: true })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Robinhood Chain wallet confirmed" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { walletCalls: string[] }).walletCalls,
    ),
  ).toEqual([
    "MetaMask:eth_requestAccounts",
    "MetaMask:personal_sign",
    "Backpack:connect",
    "Backpack:signMessage",
    "MetaMask:eth_requestAccounts",
    "MetaMask:personal_sign",
  ]);
  expect(
    writes.filter((w) => w.path === "wallets/register").map((w) => w.body),
  ).toEqual([
    { chain: "base", address: evmAddress },
    { chain: "solana", address: solanaAddress },
    { chain: "robinhood", address: evmAddress },
  ]);
  expect(writes.filter((w) => w.path === "wallets/authorize")).toHaveLength(3);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
});

test("Escape and close cancel without wallet requests and return focus", async ({
  page,
}) => {
  const writes = await payments(page);
  await providers(page);
  await page.goto("/earnings");
  await openPicker(page, "Base");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Connect Base wallet", exact: true }),
  ).toBeFocused();
  const solana = await openPicker(page, "Solana");
  await solana.getByRole("button", { name: "Close wallet picker" }).click();
  await expect(solana).not.toBeVisible();
  expect(writes).toEqual([]);
  expect(
    await page.evaluate(
      () => (window as unknown as { walletCalls: string[] }).walletCalls,
    ),
  ).toEqual([]);
});

test("wallet rejection stops registration and permits reopening the modal", async ({
  page,
}) => {
  const writes = await payments(page);
  await providers(page, true);
  await page.goto("/earnings");
  const dialog = await openPicker(page, "Base");
  await dialog
    .getByRole("button", { name: "MetaMask Detected", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Wallet request rejected",
  );
  expect(writes).toEqual([]);
  await openPicker(page, "Base");
});

test("repeated announcements do not duplicate options and removed Solana wallet disappears", async ({
  page,
}) => {
  await payments(page);
  await providers(page);
  await page.goto("/earnings");
  const dialog = await openPicker(page, "Solana");
  await expect(
    dialog.getByRole("button", { name: "Backpack Detected", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    const testWindow = window as unknown as {
      announceWallets(): void;
      removeBackpack(): void;
    };
    testWindow.announceWallets();
    testWindow.removeBackpack();
  });
  await expect(
    dialog.getByRole("button", { name: "Backpack Detected", exact: true }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close wallet picker" }).click();
  const base = await openPicker(page, "Base");
  await expect(
    base.getByRole("button", { name: "MetaMask Detected", exact: true }),
  ).toHaveCount(1);
  await expect(
    base.getByRole("button", { name: "Phantom Detected", exact: true }),
  ).toHaveCount(1);
});

test("no wallets offers official install links in either network modal", async ({
  page,
}) => {
  const writes = await payments(page);
  await page.goto("/earnings");
  for (const chain of ["Base", "Solana"] as const) {
    const dialog = await openPicker(page, chain);
    await expect(
      dialog.getByText("No wallet detected.", { exact: false }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("link", { name: "MetaMask Install", exact: false }),
    ).toHaveAttribute("href", "https://metamask.io/download");
    await expect(
      dialog.getByRole("link", { name: "Phantom Install", exact: false }),
    ).toHaveAttribute("href", "https://phantom.com/download");
    await expect(
      dialog.getByRole("button", { name: "Detected", exact: false }),
    ).toHaveCount(0);
    await dialog.getByRole("button", { name: "Close wallet picker" }).click();
  }
  expect(writes).toEqual([]);
});

test("legacy wallet browser remains connectable through the modal", async ({
  page,
}) => {
  await payments(page);
  await page.addInitScript(
    ({ evmAddress }) => {
      Object.assign(window, {
        ethereum: {
          isMetaMask: true,
          request: async ({ method }: { method: string }) =>
            method === "eth_requestAccounts" ? [evmAddress] : "0xfixture",
        },
      });
    },
    { evmAddress },
  );
  await page.goto("/earnings");
  const dialog = await openPicker(page, "Base");
  await dialog
    .getByRole("button", { name: "MetaMask Detected", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Base wallet confirmed" }),
  ).toBeVisible();
});

test("conflicting EIP-6963 UUID removes both providers without wallet requests", async ({
  page,
}) => {
  const writes = await payments(page);
  await providers(page);
  await page.goto("/earnings");
  const dialog = await openPicker(page, "Base");
  await expect(
    dialog.getByRole("button", { name: "MetaMask Detected", exact: true }),
  ).toHaveCount(1);
  await page.evaluate(() =>
    (window as unknown as { announceImpostor(): void }).announceImpostor(),
  );
  await expect(
    dialog.getByRole("button", { name: "MetaMask Detected", exact: true }),
  ).toHaveCount(0);
  // Phantom keeps its own valid UUID and stays available.
  await expect(
    dialog.getByRole("button", { name: "Phantom Detected", exact: true }),
  ).toHaveCount(1);
  // A later genuine reannouncement cannot restore the blocked UUID.
  await page.evaluate(() =>
    (window as unknown as { announceWallets(): void }).announceWallets(),
  );
  await expect(
    dialog.getByRole("button", { name: "MetaMask Detected", exact: true }),
  ).toHaveCount(0);
  expect(writes).toEqual([]);
  expect(
    await page.evaluate(
      () => (window as unknown as { walletCalls: string[] }).walletCalls,
    ),
  ).toEqual([]);
});

test("mixed standard and legacy discovery keeps every distinct wallet", async ({
  page,
}) => {
  const writes = await payments(page);
  await page.addInitScript(
    ({ evmAddress, solanaAddress }) => {
      const calls: string[] = [];
      const evm = (name: string, flags: Record<string, boolean>) => ({
        ...flags,
        request: async ({ method }: { method: string }) => {
          calls.push(`${name}:${method}`);
          return method === "eth_requestAccounts"
            ? [evmAddress]
            : "0xfixture-signature";
        },
      });
      const metamask = evm("MetaMask", { isMetaMask: true });
      const coinbase = evm("Coinbase", { isCoinbaseWallet: true });
      // MetaMask is in both EIP-6963 and the legacy list; Coinbase is legacy only.
      Object.assign(window, {
        ethereum: { ...metamask, providers: [metamask, coinbase] },
        walletCalls: calls,
      });
      window.addEventListener("eip6963:requestProvider", () =>
        window.dispatchEvent(
          new CustomEvent("eip6963:announceProvider", {
            detail: {
              provider: metamask,
              info: {
                uuid: "6f9e2d1c-8b7a-4e3d-a2c1-0f9e8d7c6b5a",
                name: "MetaMask",
                rdns: "io.metamask",
                icon: "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22/%3E",
              },
            },
          }),
        ),
      );
      const legacySolana = (name: string, flags: Record<string, boolean>) => ({
        ...flags,
        connect: async () => {
          calls.push(`${name}:connect`);
          return { publicKey: { toString: () => solanaAddress } };
        },
        signMessage: async () => {
          calls.push(`${name}:signMessage`);
          return { signature: new Uint8Array(64) };
        },
      });
      // Phantom is in both Wallet Standard and the legacy globals; Solflare is legacy only.
      Object.assign(window, {
        phantom: { solana: legacySolana("LegacyPhantom", { isPhantom: true }) },
        solana: legacySolana("Solflare", { isSolflare: true }),
      });
      window.addEventListener("wallet-standard:app-ready", (event) => {
        const account = {
          address: solanaAddress,
          publicKey: new Uint8Array(32),
          chains: ["solana:mainnet"],
          features: ["solana:signMessage"],
        };
        (event as CustomEvent).detail.register({
          name: "Phantom",
          version: "1.0.0",
          icon: "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22/%3E",
          chains: ["solana:mainnet"],
          accounts: [],
          features: {
            "standard:connect": {
              version: "1.0.0",
              connect: async () => {
                calls.push("Phantom:connect");
                return { accounts: [account] };
              },
            },
            "solana:signMessage": {
              version: "1.0.0",
              signMessage: async ({ message }: { message: Uint8Array }) => {
                calls.push("Phantom:signMessage");
                return [
                  { signedMessage: message, signature: new Uint8Array(64) },
                ];
              },
            },
          },
        });
      });
    },
    { evmAddress, solanaAddress },
  );
  await page.goto("/earnings");
  const base = await openPicker(page, "Base");
  await expect(base.getByRole("button", { name: /Detected$/u })).toHaveText([
    "MetaMaskDetected",
    "Coinbase WalletDetected",
  ]);
  await base
    .getByRole("button", { name: "Coinbase Wallet Detected", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Base wallet confirmed" }),
  ).toBeVisible();
  const solana = await openPicker(page, "Solana");
  await expect(solana.getByRole("button", { name: /Detected$/u })).toHaveText([
    "PhantomDetected",
    "SolflareDetected",
  ]);
  await solana
    .getByRole("button", { name: "Solflare Detected", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Solana wallet confirmed" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { walletCalls: string[] }).walletCalls,
    ),
  ).toEqual([
    "Coinbase:eth_requestAccounts",
    "Coinbase:personal_sign",
    "Solflare:connect",
    "Solflare:signMessage",
  ]);
  expect(
    writes.filter((w) => w.path === "wallets/register").map((w) => w.body),
  ).toEqual([
    { chain: "base", address: evmAddress },
    { chain: "solana", address: solanaAddress },
  ]);
});

// The repository's 200% text-enlargement fixture at the 320px reflow width,
// plus a 160 CSS px layout, which is what native 200% browser zoom gives a
// 320px screen.
for (const scenario of [
  { name: "320px with 200% text", width: 320, textScale: 2 },
  { name: "320px at 200% browser zoom", width: 160, textScale: 1 },
]) {
  test(`open modal reflows at ${scenario.name}`, async ({ page }, info) => {
    test.skip(
      info.project.name !== "narrow-mobile-chromium",
      "Sets its own viewport; runs once",
    );
    await payments(page);
    await providers(page);
    await page.setViewportSize({ width: scenario.width, height: 800 });
    for (const chain of ["Base", "Solana"] as const) {
      await page.goto("/earnings");
      const dialog = await openPicker(page, chain);
      await expect(
        dialog.getByRole("button", { name: /Detected$/u }),
      ).toHaveCount(2);
      if (scenario.textScale === 2)
        await page.evaluate(() => {
          // Read every size first so nested text is enlarged exactly once.
          const typography = [
            ...document.querySelectorAll<HTMLElement>("body *"),
          ].map((element) => ({
            element,
            font: getComputedStyle(element).fontSize,
            line: getComputedStyle(element).lineHeight,
          }));
          for (const { element, font, line } of typography) {
            element.style.fontSize = `${Number.parseFloat(font) * 2}px`;
            if (line !== "normal")
              element.style.lineHeight = `${Number.parseFloat(line) * 2}px`;
          }
        });
      await expect(
        dialog.getByRole("button", { name: "Close wallet picker" }),
      ).toBeInViewport();
      expect(
        await dialog.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return {
            dialogScroll: element.scrollWidth - element.clientWidth,
            insideViewport: box.left >= 0 && box.right <= window.innerWidth,
            escaping: [...element.querySelectorAll("*")]
              .filter((child) => {
                const rect = child.getBoundingClientRect();
                return rect.left < box.left - 1 || rect.right > box.right + 1;
              })
              .map((child) => child.textContent?.slice(0, 40)),
          };
        }),
      ).toEqual({ dialogScroll: 0, insideViewport: true, escaping: [] });
      const axe = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      expect(axe.violations).toEqual([]);
      await page.screenshot({
        path: info.outputPath(
          `wallet-modal-${chain.toLowerCase()}-${scenario.width}.png`,
        ),
      });
      await dialog.getByRole("button", { name: "Close wallet picker" }).click();
      await expect(dialog).not.toBeVisible();
    }
  });
}
