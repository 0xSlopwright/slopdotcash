/** Browser-only synthetic identity responses never register a real wallet. */
import { createHash } from "node:crypto";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import {
  type BrowserContext,
  expect,
  type Page,
  type TestInfo,
  test,
} from "@playwright/test";
import { deploymentOrigins, deploymentTier } from "../../src/lib/deployment";
import type { WalletAuthorization } from "../../src/lib/wallet-registration";

const deployment = deploymentOrigins(
  deploymentTier(process.env.VITE_SLOP_ENVIRONMENT),
);

test.setTimeout(120_000);

const address = "11111111111111111111111111111111";
const sha = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("legacy wallet links open Account Wallets on direct navigation and reload", {
  tag: ["@pages"],
}, async ({ page }) => {
  for (const path of ["/wallet", "/wallet/"]) {
    const response = await page.goto(path, { waitUntil: "networkidle" });
    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL(/\/account#wallets$/u);
    await expect(
      page.getByRole("heading", { name: "Account", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Wallets", exact: true }),
    ).toBeInViewport();
    const reloaded = await page.reload({ waitUntil: "networkidle" });
    expect(reloaded?.status()).toBe(200);
    await expect(
      page.getByRole("button", { name: "Verify with GitHub" }),
    ).toBeVisible();
    await expect(
      page.getByRole("listitem").filter({ hasText: "Address" }),
    ).toHaveAttribute("aria-current", "step");
  }
});

function observe(page: Page) {
  const errors: string[] = [];
  const network: { path: string; status: number }[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("requestfailed", (request) => {
    errors.push(
      `${new URL(request.url()).pathname}: ${request.failure()?.errorText}`,
    );
  });
  page.on("response", (response) => {
    if (new URL(response.url()).origin === new URL(page.url()).origin)
      network.push({
        path: new URL(response.url()).pathname,
        status: response.status(),
      });
  });
  return { errors, network };
}

async function audit(page: Page, info: TestInfo, label: string) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  await info.attach(`${label}-axe.json`, {
    body: JSON.stringify(
      { violations: result.violations, passes: result.passes.map((p) => p.id) },
      null,
      2,
    ),
    contentType: "application/json",
  });
  const screenshotPath = info.outputPath(`${label}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await info.attach(`${label}.png`, {
    path: screenshotPath,
    contentType: "image/png",
  });
  expect(result.violations, label).toEqual([]);
  const splitWords = await page.evaluate(() => {
    const failures: string[] = [];
    for (const element of document.querySelectorAll(
      ".site-header a, .wordmark, .payout-steps button",
    )) {
      if (!(element as HTMLElement).offsetWidth) continue;
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (const match of (node.textContent ?? "").matchAll(/\S+/g)) {
          const range = document.createRange();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          const lines = new Set(
            [...range.getClientRects()].map((rect) => Math.round(rect.top)),
          );
          if (lines.size > 1) failures.push(match[0]);
        }
      }
    }
    return failures;
  });
  expect(splitWords, `${label} keeps navigation words intact`).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    ),
    `${label} page overflow`,
  ).toBeLessThanOrEqual(1);
}

async function keyboardTo(
  page: Page,
  target: ReturnType<Page["getByRole"]>,
  reverse = false,
) {
  for (let count = 0; count < 80; count++) {
    if (await target.evaluate((element) => element === document.activeElement))
      return;
    await page.keyboard.press(reverse ? "Shift+Tab" : "Tab");
  }
  await expect(target).toBeFocused();
}

test("funding and wallet keyboard flows remain accessible at 200 percent text size", async ({
  page,
}, info) => {
  const evidence = observe(page);
  for (const path of ["/wallet", "/projects/eliza/funding#payouts"]) {
    await page.goto(path, { waitUntil: "networkidle" });
    await page.evaluate(() => {
      const sizes = [...document.querySelectorAll<HTMLElement>("body *")].map(
        (element) => ({
          element,
          font: getComputedStyle(element).fontSize,
          line: getComputedStyle(element).lineHeight,
        }),
      );
      for (const { element, font, line } of sizes) {
        element.style.fontSize = `${Number.parseFloat(font) * 2}px`;
        if (line !== "normal")
          element.style.lineHeight = `${Number.parseFloat(line) * 2}px`;
      }
    });
    if (path === "/wallet") {
      const input = page.getByLabel("Solana public address");
      await keyboardTo(page, input);
      await page.keyboard.type("invalid");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("alert")).toContainText(
        "valid Solana public address",
      );
      await audit(page, info, "wallet-200-percent-text");
    } else {
      const panel = page.locator(".funding-workbench");
      await panel.getByLabel("Contribution month").selectOption("2026-08");
      await keyboardTo(page, panel.getByLabel("Find contributor"));
      await page.keyboard.type("lalalune");
      await expect(panel.locator(".recipient-row")).toHaveCount(1);
      await audit(page, info, "funding-review-200-percent-text");
      for (const label of [
        "Prepare funding",
        "Approve cycle",
        "Track payments",
      ]) {
        const button = panel.getByRole("button", { name: label });
        await keyboardTo(page, button, label === "Prepare funding");
        await page.keyboard.press("Enter");
        await expect(button).toHaveAttribute("aria-current", "step");
        await audit(
          page,
          info,
          `funding-${label.toLowerCase().replaceAll(" ", "-")}`,
        );
      }
      await expect(panel).toContainText("Payments have not been authorized");
    }
  }
  await info.attach("console-network.json", {
    body: JSON.stringify(evidence, null, 2),
    contentType: "application/json",
  });
  expect(evidence.errors).toEqual([]);
  expect(evidence.network.filter((r) => r.status >= 400)).toEqual([]);
});

/**
 * Routes a synthetic GitHub sign-in for `owner`; opening the authorize page
 * completes the flow. Returns the session token and the sign-in start count.
 */
async function routeSyntheticSignIn(
  context: BrowserContext,
  owner: { githubActorId: string; githubLogin: string },
  expiresAt: string,
): Promise<{
  starts: number;
  token: string;
  authorization: WalletAuthorization;
}> {
  const flowId = `flow_${"f".repeat(24)}`;
  const signIn = {
    starts: 0,
    authorization: {
      flowId,
      pollCapability: "p".repeat(48),
      expiresAt,
      pollAfterSeconds: 1,
      authorizationUrl: `${deployment.identity}/v1/oauth/authorize?flow_id=${flowId}&state=${"s".repeat(48)}`,
    },
    token: `fixture.${Buffer.from(
      JSON.stringify({
        githubId: owner.githubActorId,
        githubLogin: owner.githubLogin,
        iss: "slop.cash",
        aud: "private-trace-api",
        sub: `github:${owner.githubActorId}`,
        exp: Date.parse(expiresAt) / 1000,
      }),
    ).toString("base64url")}.fixture`,
  };
  let authorized = false;
  await context.route(`${deployment.identity}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/oauth/authorize") {
      authorized = true;
      await route.fulfill({
        contentType: "text/html",
        body: "<title>Synthetic OAuth fixture</title>Test sign-in complete",
      });
    } else if (path === "/v1/oauth/start") {
      signIn.starts++;
      authorized = false;
      await route.fulfill({
        json: signIn.authorization,
      });
    } else if (path === "/v1/oauth/poll") {
      if (!authorized) {
        await route.fulfill({
          status: 202,
          json: { status: "pending", retryAfterSeconds: 1 },
        });
        return;
      }
      await route.fulfill({
        json: {
          status: "complete",
          assertionType: "SlopIdentity",
          assertion: `slop_assert_v1_${"a".repeat(48)}`,
          expiresAt,
        },
      });
    } else throw new Error(`Unexpected identity request ${path}`);
  });
  return signIn;
}

test("membership hydration preserves and refreshes a wallet same-tab recovery", async ({
  page,
  context,
}) => {
  const evidence = observe(page);
  const owner = { githubActorId: "123", githubLogin: "qa-fixture" };
  const expiresAt = new Date(
    Math.floor(Date.now() / 1000) * 1000 + 240_000,
  ).toISOString();
  const signIn = await routeSyntheticSignIn(context, owner, expiresAt);
  let releaseMembership!: () => void;
  const membership = new Promise<void>((resolve) => {
    releaseMembership = resolve;
  });
  let exchanging!: () => void;
  const assertionExchanging = new Promise<void>((resolve) => {
    exchanging = resolve;
  });
  let releaseSession!: () => void;
  const session = new Promise<void>((resolve) => {
    releaseSession = resolve;
  });
  let confirmationStarted!: () => void;
  const confirming = new Promise<void>((resolve) => {
    confirmationStarted = resolve;
  });
  let releaseConfirmation!: () => void;
  const confirmation = new Promise<void>((resolve) => {
    releaseConfirmation = resolve;
  });
  let confirmed = false;
  const previousAddress = "Vote111111111111111111111111111111111111111";
  const previousCanonical = {
    schemaVersion: 1,
    ...owner,
    address: previousAddress,
    source: "d1_registry",
    issueRepository: null,
    issueNumber: null,
    sourceBodySha256: "a".repeat(64),
    observedAt: "2026-10-13T12:00:00.000Z",
    supersedesClaimId: null,
  };
  const previousClaim = {
    ...previousCanonical,
    claimId: "qa_previous_claim",
    recordDigest: sha(previousCanonical),
  };
  const canonical = {
    schemaVersion: 1,
    ...owner,
    address,
    source: "d1_registry",
    issueRepository: null,
    issueNumber: null,
    sourceBodySha256: sha({
      schemaVersion: 1,
      githubActorId: owner.githubActorId,
      address,
      supersedesClaimId: previousClaim.claimId,
    }),
    observedAt: "2026-10-14T12:00:00.000Z",
    supersedesClaimId: previousClaim.claimId,
  };
  const claim = {
    ...canonical,
    claimId: "qa_saved_claim",
    recordDigest: sha(canonical),
  };
  await context.route(`${deployment.site}/**`, (route) =>
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
  await context.route(`${deployment.site}/api/v1/points/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/points/me") {
      await membership;
      await route.fulfill({
        json: {
          actor: {
            id: Buffer.from(`04:User${owner.githubActorId}`).toString("base64"),
            login: owner.githubLogin,
          },
          joinedAt: "2026-10-01T00:00:00.000Z",
          public: false,
          welcome: 5,
          socialPoints: 0,
        },
      });
    } else if (path === "/api/v1/points/x/me")
      await route.fulfill({
        json: { configured: false, account: null, award: null },
      });
    else throw new Error(`Unexpected membership request ${path}`);
  });
  await context.route(
    (url) =>
      url.origin === deployment.api &&
      (url.pathname === "/api/v1/auth/session" ||
        url.pathname === "/api/v1/wallet-claims" ||
        url.pathname.startsWith("/api/v1/wallet-claims/")),
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/v1/auth/session") {
        exchanging();
        await session;
        await route.fulfill({
          json: { tokenType: "Bearer", token: signIn.token, expiresAt },
        });
      } else if (path === "/api/v1/wallet-claims/current") {
        await route.fulfill({ json: previousClaim });
      } else if (path === "/api/v1/wallet-claims") {
        confirmationStarted();
        await confirmation;
        confirmed = true;
        await route.fulfill({ json: claim });
      } else if (
        path === `/api/v1/wallet-claims/actors/${owner.githubActorId}/current`
      )
        await route.fulfill({ json: confirmed ? claim : previousClaim });
      else throw new Error(`Unexpected API request ${path}`);
    },
  );
  await context.route("https://avatars.githubusercontent.com/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"/>',
    }),
  );
  await page.addInitScript(
    ({ site, authorization, address }) => {
      if (window.location.origin !== site) return;
      sessionStorage.setItem(
        "slop-wallet-authorization",
        JSON.stringify(authorization),
      );
      sessionStorage.setItem("slop-wallet-address", address);
    },
    { site: deployment.site, authorization: signIn.authorization, address },
  );
  try {
    await page.goto(signIn.authorization.authorizationUrl);
    await page.goto(`${deployment.site}/account#wallets`);
    // Identity completion has consumed the saved authorization, while the
    // independent account membership response is still waiting to arrive.
    await assertionExchanging;
    releaseSession();
    await expect(
      page.getByRole("heading", { name: "Confirm your public registration" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Register address" }).click();
    await confirming;
    releaseMembership();
    await expect(
      page.getByRole("heading", { name: `@${owner.githubLogin}`, exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "Current Solana registration" })
        .getByText(previousAddress, { exact: true }),
    ).toBeVisible();
    releaseConfirmation();
    await expect(
      page.getByRole("heading", { name: "Wallet registered" }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "Current Solana registration" })
        .getByText(address, { exact: true }),
    ).toBeVisible();
    expect(signIn.starts).toBe(0);
    expect(evidence.errors).toEqual([]);
  } finally {
    releaseMembership();
    releaseSession();
    releaseConfirmation();
  }
});

for (const sameTab of [false, true]) {
  test(`wallet ${sameTab ? "same-tab recovery" : "popup"} requires confirmation and verifies the returned public proof`, async ({
    page,
    context,
  }, info) => {
    const evidence = observe(page);
    let writes = 0;
    if (sameTab)
      await page.addInitScript(() => {
        window.open = () => null;
      });
    const owner = { githubActorId: "123", githubLogin: "qa-fixture" };
    const expiresAt = new Date(
      Math.floor(Date.now() / 1000) * 1000 + 240_000,
    ).toISOString();
    const canonical = {
      schemaVersion: 1,
      ...owner,
      address,
      source: "d1_registry",
      issueRepository: null,
      issueNumber: null,
      sourceBodySha256: sha({
        schemaVersion: 1,
        githubActorId: owner.githubActorId,
        address,
        supersedesClaimId: null,
      }),
      observedAt: new Date().toISOString(),
      supersedesClaimId: null,
    };
    const signIn = await routeSyntheticSignIn(context, owner, expiresAt);
    await context.route(`${deployment.api}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/v1/auth/session") {
        await route.fulfill({
          json: { tokenType: "Bearer", token: signIn.token, expiresAt },
        });
      } else if (path === "/api/v1/wallet-claims/current") {
        // A real existing claim avoids treating an expected 404 as a console failure.
        const oldAddress = "Vote111111111111111111111111111111111111111";
        const old = { ...canonical, address: oldAddress };
        await route.fulfill({
          json: { ...old, claimId: "qa_old_claim", recordDigest: sha(old) },
        });
      } else if (path === "/api/v1/wallet-claims") {
        writes++;
        expect(route.request().postDataJSON()).toEqual({
          address,
          supersedesClaimId: "qa_old_claim",
        });
        const next = {
          ...canonical,
          supersedesClaimId: "qa_old_claim",
          sourceBodySha256: sha({
            schemaVersion: 1,
            githubActorId: owner.githubActorId,
            address,
            supersedesClaimId: "qa_old_claim",
          }),
        };
        await route.fulfill({
          json: { ...next, claimId: "qa_new_claim", recordDigest: sha(next) },
        });
      } else throw new Error(`Unexpected API request ${path}`);
    });
    await page.goto("/account#wallets", { waitUntil: "networkidle" });
    await keyboardTo(page, page.getByLabel("Solana public address"));
    await page.keyboard.type(address);
    await page.keyboard.press("Enter");
    async function returnFromSameTab() {
      if (!sameTab) return;
      await page
        .getByRole("link", { name: "Continue to GitHub in this tab" })
        .click();
      await expect(page).toHaveTitle("Synthetic OAuth fixture");
      await page.goBack({ waitUntil: "networkidle" });
      await expect(page.getByLabel("Solana public address")).toHaveValue(
        address,
      );
    }
    await returnFromSameTab();
    await expect(
      page.getByRole("heading", { name: "Confirm your public registration" }),
    ).toBeVisible();
    expect(writes).toBe(0);
    expect(signIn.starts).toBe(1);
    await expect(page.locator(".funding-workbench")).toContainText(
      owner.githubLogin,
    );
    await audit(page, info, "wallet-preview");
    await keyboardTo(
      page,
      page.getByRole("button", { name: "Cancel", exact: true }),
    );
    await page.keyboard.press("Enter");
    await expect(page.getByRole("alert")).toContainText(
      "No wallet claim was submitted",
    );
    expect(writes).toBe(0);
    await keyboardTo(
      page,
      page.getByRole("button", { name: "Verify with GitHub" }),
    );
    await page.keyboard.press("Enter");
    await returnFromSameTab();
    const confirm = page.getByRole("button", {
      name: "Register address",
      exact: true,
    });
    await expect(confirm).toBeVisible();
    const consequence = page.getByText(
      "Your GitHub identity and this address become a public, permanent record.",
    );
    await expect(consequence).toBeVisible();
    // The public-registration consequence sits immediately before the action.
    expect(
      await consequence.evaluate(
        (text) =>
          text.closest("p")?.nextElementSibling?.textContent ===
          "Register address",
      ),
    ).toBe(true);
    await expect(
      page.getByRole("listitem").filter({ hasText: "Confirm" }),
    ).toHaveAttribute("aria-current", "step");
    await keyboardTo(page, confirm);
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Wallet registered", exact: true }),
    ).toBeVisible();
    expect(writes).toBe(1);
    expect(signIn.starts).toBe(2);
    await expect(page.getByText(/^Record digest:/u)).toBeHidden();
    await expect(
      page.getByRole("listitem").filter({ hasText: "Saved" }),
    ).toHaveAttribute("aria-current", "step");
    await page.getByText("Technical details", { exact: true }).click();
    await expect(page.getByText(/^Record digest:/u)).toBeVisible();
    await expect(
      page.getByRole("link", { name: "View public record" }),
    ).toHaveAttribute(
      "href",
      `${deployment.api}/api/v1/wallet-claims/qa_new_claim`,
    );
    await audit(page, info, "wallet-confirmed-synthetic");
    await info.attach("console-network.json", {
      body: JSON.stringify(evidence, null, 2),
      contentType: "application/json",
    });
    expect(evidence.errors).toEqual([]);
    expect(evidence.network.filter((r) => r.status >= 400)).toEqual([]);
  });
}

const renamed = { githubActorId: "123", githubLogin: "qa-renamed" };
const otherAddress = "Vote111111111111111111111111111111111111111";

/**
 * Routes a renamed account whose current claim was recorded under the earlier
 * login. `claimActorId` overrides the claim's numeric ID; `successorLogin` is
 * the login the API records on a new claim. Returns the registry write count.
 */
async function routeRenamedAccount(
  context: BrowserContext,
  {
    claimActorId = renamed.githubActorId,
    successorLogin = renamed.githubLogin,
  } = {},
): Promise<{ writes: number }> {
  const api = { writes: 0 };
  const expiresAt = new Date(
    Math.floor(Date.now() / 1000) * 1000 + 240_000,
  ).toISOString();
  const recorded = {
    schemaVersion: 1,
    githubActorId: claimActorId,
    githubLogin: "qa-fixture",
    address,
    source: "d1_registry",
    issueRepository: null,
    issueNumber: null,
    sourceBodySha256: sha({
      schemaVersion: 1,
      githubActorId: claimActorId,
      address,
      supersedesClaimId: null,
    }),
    observedAt: new Date(Date.now() - 86_400_000).toISOString(),
    supersedesClaimId: null,
  };
  const signIn = await routeSyntheticSignIn(context, renamed, expiresAt);
  await context.route(`${deployment.api}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/auth/session") {
      await route.fulfill({
        json: { tokenType: "Bearer", token: signIn.token, expiresAt },
      });
    } else if (path === "/api/v1/wallet-claims/current") {
      await route.fulfill({
        json: {
          ...recorded,
          claimId: "qa_recorded_claim",
          recordDigest: sha(recorded),
        },
      });
    } else if (path === "/api/v1/wallet-claims") {
      api.writes++;
      // Like the API, append a successor under the session's numeric ID.
      const { address: next, supersedesClaimId } = route
        .request()
        .postDataJSON();
      expect(supersedesClaimId).toBe("qa_recorded_claim");
      const successor = {
        ...recorded,
        githubActorId: renamed.githubActorId,
        githubLogin: successorLogin,
        address: next,
        sourceBodySha256: sha({
          schemaVersion: 1,
          githubActorId: renamed.githubActorId,
          address: next,
          supersedesClaimId,
        }),
        observedAt: new Date().toISOString(),
        supersedesClaimId,
      };
      await route.fulfill({
        json: {
          ...successor,
          claimId: "qa_successor_claim",
          recordDigest: sha(successor),
        },
      });
    } else throw new Error(`Unexpected API request ${path}`);
  });
  return api;
}

async function startRegistration(page: Page, value: string) {
  await page.goto("/account#wallets", { waitUntil: "networkidle" });
  await keyboardTo(page, page.getByLabel("Solana public address"));
  await page.keyboard.type(value);
  await page.keyboard.press("Enter");
}

async function confirmRegistration(page: Page) {
  await expect(
    page.getByRole("heading", { name: "Confirm your public registration" }),
  ).toBeVisible();
  await keyboardTo(
    page,
    page.getByRole("button", { name: "Register address", exact: true }),
  );
  await page.keyboard.press("Enter");
}

test("a renamed GitHub account opens its wallet claim and keeps it for the same address", async ({
  page,
  context,
}, info) => {
  const evidence = observe(page);
  // ACC-01: the numeric ID owns the claim, so the earlier login still opens it.
  const api = await routeRenamedAccount(context);
  await startRegistration(page, address);
  await expect(
    page.getByRole("heading", { name: "Confirm your public registration" }),
  ).toBeVisible();
  await expect(page.locator(".wallet-confirmation")).toContainText(
    renamed.githubLogin,
  );
  await audit(page, info, "wallet-renamed-preview");
  await confirmRegistration(page);
  await expect(
    page.getByRole("heading", { name: "Wallet registered", exact: true }),
  ).toBeVisible();
  // A login-only successor would supersede the claim that payout
  // authorization is keyed to, so the unchanged address is not re-sent.
  expect(api.writes).toBe(0);
  await expect(
    page.getByRole("link", { name: "View public record" }),
  ).toHaveAttribute(
    "href",
    `${deployment.api}/api/v1/wallet-claims/qa_recorded_claim`,
  );
  await audit(page, info, "wallet-renamed-unchanged");
  await info.attach("console-network.json", {
    body: JSON.stringify(evidence, null, 2),
    contentType: "application/json",
  });
  expect(evidence.errors).toEqual([]);
  expect(evidence.network.filter((r) => r.status >= 400)).toEqual([]);
});

test("a renamed GitHub account registers a new address under its current login", async ({
  page,
  context,
}) => {
  const api = await routeRenamedAccount(context);
  await startRegistration(page, otherAddress);
  await confirmRegistration(page);
  await expect(
    page.getByRole("heading", { name: "Wallet registered", exact: true }),
  ).toBeVisible();
  expect(api.writes).toBe(1);
  await expect(page.locator(".funding-workbench")).toContainText(
    `Saved for ${renamed.githubLogin}`,
  );
});

test("a current claim recorded for another numeric GitHub ID is rejected before any write", async ({
  page,
  context,
}) => {
  const api = await routeRenamedAccount(context, { claimActorId: "456" });
  await startRegistration(page, address);
  await expect(page.getByRole("alert")).toContainText(
    "Returned wallet claim belongs to a different GitHub identity.",
  );
  await expect(
    page.getByRole("heading", { name: "Confirm your public registration" }),
  ).toBeHidden();
  expect(api.writes).toBe(0);
});

test("a created successor carrying another login is not shown as saved", async ({
  page,
  context,
}) => {
  const api = await routeRenamedAccount(context, {
    successorLogin: "qa-fixture",
  });
  await startRegistration(page, otherAddress);
  await confirmRegistration(page);
  await expect(page.getByRole("alert")).toContainText(
    "Returned wallet registration does not match the confirmed address and predecessor.",
  );
  await expect(
    page.getByRole("heading", { name: "Wallet registered", exact: true }),
  ).toBeHidden();
  expect(api.writes).toBe(1);
});

// EIP-55 example address: wallets copy it in this checksum case.
const checksummed = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

for (const [chain, label] of [
  ["base", "Base"],
  ["robinhood", "Robinhood Chain"],
] as const) {
  test(`a checksummed ${label} address is accepted and registered in lowercase`, async ({
    page,
    context,
  }, info) => {
    const evidence = observe(page);
    const owner = { githubActorId: "123", githubLogin: "qa-fixture" };
    const expiresAt = new Date(
      Math.floor(Date.now() / 1000) * 1000 + 240_000,
    ).toISOString();
    const signIn = await routeSyntheticSignIn(context, owner, expiresAt);
    const posted: Record<string, unknown>[] = [];
    await context.route(`${deployment.api}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/v1/auth/session") {
        await route.fulfill({
          json: { tokenType: "Bearer", token: signIn.token, expiresAt },
        });
      } else if (path === "/api/v1/wallet-claims/current") {
        expect(new URL(route.request().url()).searchParams.get("chain")).toBe(
          chain,
        );
        await route.fulfill({ status: 404, json: { error: "not_found" } });
      } else if (path === "/api/v1/wallet-claims") {
        const body = route.request().postDataJSON();
        posted.push(body);
        const created = {
          schemaVersion: 1,
          ...owner,
          address: body.address,
          chain,
          source: "d1_registry",
          issueRepository: null,
          issueNumber: null,
          sourceBodySha256: sha({
            schemaVersion: 1,
            githubActorId: owner.githubActorId,
            address: body.address,
            chain,
            supersedesClaimId: null,
          }),
          observedAt: new Date().toISOString(),
          supersedesClaimId: null,
        };
        await route.fulfill({
          json: {
            ...created,
            claimId: "qa_evm_claim",
            recordDigest: sha(created),
          },
        });
      } else throw new Error(`Unexpected API request ${path}`);
    });
    await page.goto("/account#wallets", { waitUntil: "networkidle" });
    await page.getByLabel("Payout network").selectOption(chain);
    const input = page.getByLabel(`${label} public address`);
    // One mistyped capital fails the checksum before any sign-in starts.
    await input.fill(`${checksummed.slice(0, -1)}D`);
    await page.getByRole("button", { name: "Verify with GitHub" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "capital letters that do not match its checksum",
    );
    expect(signIn.starts).toBe(0);
    await input.fill(`  ${checksummed} `);
    await page.getByRole("button", { name: "Verify with GitHub" }).click();
    await expect(
      page.getByRole("heading", { name: "Confirm your public registration" }),
    ).toBeVisible();
    await expect(page.locator(".wallet-confirmation")).toContainText(
      checksummed.toLowerCase(),
    );
    await audit(page, info, `wallet-${chain}-checksum-preview`);
    await page
      .getByRole("button", { name: "Register address", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Wallet registered", exact: true }),
    ).toBeVisible();
    expect(posted).toEqual([
      { address: checksummed.toLowerCase(), chain, supersedesClaimId: null },
    ]);
    // The browser logs the fixture's "no current claim" 404; nothing else.
    expect(
      evidence.errors.filter((error) => !error.includes("status of 404")),
    ).toEqual([]);
  });
}
