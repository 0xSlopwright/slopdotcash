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
          [phantom, "Phantom", "a"],
          [metamask, "MetaMask", "b"],
        ] as const)
          window.dispatchEvent(
            new CustomEvent("eip6963:announceProvider", {
              detail: {
                provider,
                info: {
                  uuid,
                  name,
                  rdns: `${name}.app`,
                  icon: "data:image/png;base64,",
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
        icon: "data:image/png;base64,",
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
      Object.assign(window, { announceWallets: announce });
    },
    { reject, evmAddress, solanaAddress },
  );
}

test("choose MetaMask for Base and Backpack for Solana despite Phantom globals", async ({
  page,
}, info) => {
  const writes = await payments(page);
  await providers(page);
  await page.goto("/earnings");
  const base = page.getByRole("combobox", { name: "Base wallet", exact: true });
  const solana = page.getByRole("combobox", {
    name: "Solana wallet",
    exact: true,
  });
  await expect(
    page.getByRole("button", { name: "Connect Base wallet", exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      () => (window as unknown as { walletCalls: string[] }).walletCalls,
    ),
  ).toEqual([]);
  await base.selectOption({ label: "MetaMask" });
  await solana.selectOption({ label: "Backpack" });
  await page
    .getByRole("button", { name: "Connect Base wallet", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Base wallet confirmed" }),
  ).toBeVisible();
  await expect(solana).toHaveValue("solana-1");
  await page
    .getByRole("button", { name: "Connect Solana wallet", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Solana wallet confirmed",
  );
  expect(
    await page.evaluate(
      () => (window as unknown as { walletCalls: string[] }).walletCalls,
    ),
  ).toEqual([
    "MetaMask:eth_requestAccounts",
    "MetaMask:personal_sign",
    "Backpack:connect",
    "Backpack:signMessage",
  ]);
  expect(
    writes.filter((w) => w.path === "wallets/register").map((w) => w.body),
  ).toEqual([
    { chain: "base", address: evmAddress },
    { chain: "solana", address: solanaAddress },
  ]);
  expect(writes.filter((w) => w.path === "wallets/authorize")).toHaveLength(2);
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(axe.violations).toEqual([]);
  await page.screenshot({
    path: info.outputPath("wallet-picker.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
});

test("wallet rejection stops registration and allows another selection", async ({
  page,
}) => {
  const writes = await payments(page);
  await providers(page, true);
  await page.goto("/earnings");
  await page
    .getByRole("combobox", { name: "Base wallet", exact: true })
    .selectOption({ label: "MetaMask" });
  await page
    .getByRole("button", { name: "Connect Base wallet", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Wallet request rejected",
  );
  expect(writes).toEqual([]);
  await expect(
    page.getByRole("combobox", { name: "Base wallet", exact: true }),
  ).toBeEnabled();
});

test("repeated announcements do not duplicate choices and removed Solana wallet cannot connect", async ({
  page,
}) => {
  await payments(page);
  await providers(page);
  await page.goto("/earnings");
  const solana = page.getByRole("combobox", {
    name: "Solana wallet",
    exact: true,
  });
  await solana.selectOption({ label: "Backpack" });
  await page.evaluate(() => {
    const testWindow = window as unknown as {
      announceWallets(): void;
      removeBackpack(): void;
    };
    testWindow.announceWallets();
    testWindow.removeBackpack();
  });
  await expect(
    page
      .getByRole("combobox", { name: "Base wallet", exact: true })
      .locator("option"),
  ).toHaveCount(3);
  await expect(solana.locator("option")).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Connect Solana wallet", exact: true }),
  ).toBeDisabled();
});

test("no detected wallets explains recovery and keeps both connections disabled", async ({
  page,
}) => {
  await payments(page);
  await page.goto("/earnings");
  await expect(
    page.getByText("No Base wallet detected.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("No Solana wallet detected.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Connect Base wallet", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Connect Solana wallet", exact: true }),
  ).toBeDisabled();
});

test("legacy wallet browser remains selectable without automatic connection", async ({
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
  const base = page.getByRole("combobox", { name: "Base wallet", exact: true });
  await base.selectOption({ label: "MetaMask" });
  await page
    .getByRole("button", { name: "Connect Base wallet", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Base wallet confirmed" }),
  ).toBeVisible();
});
