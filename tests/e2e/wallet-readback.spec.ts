/** Synthetic public claims exercise Account Wallets without registering a wallet. */
import { createHash } from "node:crypto";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type Route, test } from "@playwright/test";
import { deploymentOrigins, deploymentTier } from "../../src/lib/deployment";
import type { WalletChain } from "../../src/lib/wallets";

const deployment = deploymentOrigins(
  deploymentTier(process.env.VITE_SLOP_ENVIRONMENT),
);
const owner = { githubActorId: "123", githubLogin: "readback-renamed" };
const addresses = {
  solana: "11111111111111111111111111111111",
  base: "0x1111111111111111111111111111111111111111",
  robinhood: "0x2222222222222222222222222222222222222222",
};

function savedClaim(chain: WalletChain, githubActorId = owner.githubActorId) {
  // A rename does not change the numeric identity that owns an existing claim.
  const canonical = {
    schemaVersion: 1,
    githubActorId,
    githubLogin: "readback-before-rename",
    address: addresses[chain],
    ...(chain === "solana" ? {} : { chain }),
    source: "d1_registry",
    issueRepository: null,
    issueNumber: null,
    sourceBodySha256: "a".repeat(64),
    // Migrated GitHub issue claims use the backend's valid seconds-only form.
    observedAt: "2026-10-14T12:00:00Z",
    supersedesClaimId: null,
  };
  return {
    ...canonical,
    claimId: `readback_${chain}`,
    recordDigest: createHash("sha256")
      .update(JSON.stringify(canonical))
      .digest("hex"),
  };
}

async function accountFixture(
  page: Page,
  respond: (route: Route, chain: WalletChain) => Promise<void>,
) {
  const errors: string[] = [];
  const reads: WalletChain[] = [];
  const writes: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("request", (request) => {
    if (request.url().includes("/wallet-claims") && request.method() !== "GET")
      writes.push(request.url());
  });
  const me = {
    actor: {
      id: Buffer.from(`04:User${owner.githubActorId}`).toString("base64"),
      login: owner.githubLogin,
    },
    joinedAt: "2026-10-01T00:00:00.000Z",
    public: false,
    welcome: 5,
    socialPoints: 0,
  };
  await page.route(`${deployment.site}/**`, (route) =>
    route.fulfill({
      path: join(
        process.cwd(),
        "dist",
        route.request().resourceType() === "document"
          ? "index.html"
          : new URL(route.request().url()).pathname,
      ),
    }),
  );
  await page.route(`${deployment.site}/api/v1/points/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/points/me") await route.fulfill({ json: me });
    else if (path === "/api/v1/points/x/me")
      await route.fulfill({
        json: { configured: false, account: null, award: null },
      });
    else if (path === "/api/v1/points/signout")
      await route.fulfill({ json: { signedOut: true } });
    else throw new Error(`Unexpected membership request ${path}`);
  });
  await page.route(
    `${deployment.api}/api/v1/wallet-claims/actors/*/current*`,
    async (route) => {
      const url = new URL(route.request().url());
      expect(url.pathname).toBe(
        `/api/v1/wallet-claims/actors/${owner.githubActorId}/current`,
      );
      expect(route.request().method()).toBe("GET");
      expect(route.request().headers().authorization).toBeUndefined();
      const chain = (url.searchParams.get("chain") ?? "solana") as WalletChain;
      reads.push(chain);
      await respond(route, chain);
    },
  );
  await page.route("https://avatars.githubusercontent.com/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#4f4a41"/></svg>',
    }),
  );
  return { reads, writes, errors };
}

test("Account Wallets restores saved registrations by immutable identity after reload", async ({
  page,
}, info) => {
  const evidence = await accountFixture(page, async (route, chain) => {
    await route.fulfill({
      json: chain === "robinhood" ? null : savedClaim(chain),
    });
  });
  await page.goto(`${deployment.site}/account#wallets`);
  const current = page.getByRole("region", {
    name: "Current Solana registration",
  });
  await expect(
    current.getByText(addresses.solana, { exact: true }),
  ).toBeVisible();
  await expect(
    current.getByRole("link", { name: "View public record" }),
  ).toHaveAttribute(
    "href",
    `${deployment.api}/api/v1/wallet-claims/readback_solana`,
  );
  await expect(current).toContainText("Registered receiving address");
  await expect(current).toContainText("Oct 14, 2026");
  await expect(page.getByLabel("Solana public address")).toBeEmpty();
  await page.reload();
  await expect(
    current.getByText(addresses.solana, { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Payout network").selectOption("base");
  const base = page.getByRole("region", { name: "Current Base registration" });
  await expect(base.getByText(addresses.base, { exact: true })).toBeVisible();
  await expect(current).toHaveCount(0);
  await page.getByLabel("Payout network").selectOption("robinhood");
  await expect(
    page.getByText("No Robinhood Chain receiving address registered."),
  ).toBeVisible();
  await expect(page.getByText(addresses.base, { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Confirmed for automatic payments/u)).toHaveCount(
    0,
  );
  await page.getByLabel("Payout network").selectOption("solana");
  await expect(
    current.getByText(addresses.solana, { exact: true }),
  ).toBeVisible();
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({
    path: info.outputPath("wallet-readback.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(current).toHaveCount(0);
  await expect(page.getByText(addresses.solana, { exact: true })).toHaveCount(
    0,
  );
  expect(evidence.reads).toEqual([
    "solana",
    "solana",
    "base",
    "robinhood",
    "solana",
  ]);
  expect(evidence.writes).toEqual([]);
  expect(evidence.errors).toEqual([]);
});

for (const invalid of ["wrong actor", "wrong chain", "bad digest"]) {
  test(`Account Wallets keeps a ${invalid} response distinct from no registration`, async ({
    page,
  }) => {
    const evidence = await accountFixture(page, async (route, chain) => {
      const claim =
        invalid === "wrong actor"
          ? savedClaim(chain, "456")
          : invalid === "wrong chain"
            ? savedClaim("base")
            : { ...savedClaim(chain), recordDigest: "b".repeat(64) };
      await route.fulfill({ json: claim });
    });
    await page.goto(`${deployment.site}/account#wallets`);
    await expect(
      page.getByText(
        "Current registration could not be verified. Please retry.",
      ),
    ).toBeVisible();
    await expect(
      page.getByText(/No .* receiving address registered/u),
    ).toHaveCount(0);
    await expect(page.getByText(addresses.solana, { exact: true })).toHaveCount(
      0,
    );
    expect(evidence.writes).toEqual([]);
    expect(evidence.errors).toEqual([]);
  });
}

test("Account Wallets retries an unavailable claim without hiding it as no registration", async ({
  page,
}) => {
  let unavailable = true;
  const evidence = await accountFixture(page, async (route, chain) => {
    await route.fulfill({
      json: unavailable ? { error: "unavailable" } : savedClaim(chain),
    });
  });
  await page.goto(`${deployment.site}/account#wallets`);
  await expect(
    page.getByText("Current registration could not be verified. Please retry."),
  ).toBeVisible();
  await expect(
    page.getByText(/No .* receiving address registered/u),
  ).toHaveCount(0);
  unavailable = false;
  await page
    .getByRole("button", { name: "Retry current registration" })
    .click();
  await expect(page.getByText(addresses.solana, { exact: true })).toBeVisible();
  expect(evidence.writes).toEqual([]);
  expect(evidence.errors).toEqual([]);
});

test("Account Wallets ignores a stale response after switching networks", async ({
  page,
}) => {
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let delivered!: () => void;
  const staleDelivered = new Promise<void>((resolve) => {
    delivered = resolve;
  });
  const evidence = await accountFixture(page, async (route, chain) => {
    if (chain === "solana") await delayed;
    await route.fulfill({ json: savedClaim(chain) });
    if (chain === "solana") delivered();
  });
  await page.goto(`${deployment.site}/account#wallets`);
  await expect.poll(() => evidence.reads).toEqual(["solana"]);
  await page.getByLabel("Payout network").selectOption("base");
  await expect(page.getByText(addresses.base, { exact: true })).toBeVisible();
  release();
  await staleDelivered;
  await expect(
    page.getByRole("region", { name: "Current Base registration" }),
  ).toContainText(addresses.base);
  await expect(page.getByText(addresses.solana, { exact: true })).toHaveCount(
    0,
  );
  expect(evidence.writes).toEqual([]);
  expect(evidence.errors).toEqual([]);
});
