/** Actual Pages session + D1 preferences + shipped local notify Worker. No real email is sent. */
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("verified activity email preference persists and can be withdrawn @registry", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: test.info().project.use.viewport,
    recordVideo: { dir: test.info().outputPath("email-preference-video") },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  const failures: string[] = [];
  await page.goto("/how-it-works");
  await page.evaluate((token) => {
    document.cookie = `__Host-slop_points=${token}; Path=/; Secure; SameSite=Strict`;
  }, process.env.SLOP_E2E_APPLICANT_TOKEN ?? "");
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (
      new URL(response.url()).origin === new URL(page.url()).origin &&
      response.status() >= 400
    )
      failures.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
  page.on("requestfailed", (request) =>
    failures.push(
      `${new URL(request.url()).pathname} ${request.failure()?.errorText}`,
    ),
  );
  await page.goto("/inbox", { waitUntil: "networkidle" });
  const preferences = page.getByRole("region", { name: "Email preferences" });
  await expect(preferences).toContainText("applicant@example.com");
  // Tests share a synthetic account across widths; each starts by restoring opt-out.
  const off = preferences.getByRole("button", {
    name: "Turn off activity email",
  });
  if (await off.isVisible()) await off.click();
  await page.screenshot({
    path: test.info().outputPath("optional-email-before.png"),
    fullPage: true,
  });
  await preferences
    .getByRole("button", { name: "Turn on activity email" })
    .focus();
  const enabledResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/notifications/email",
  );
  await page.keyboard.press("Enter");
  expect((await enabledResponse).status()).toBe(200);
  await expect(preferences.getByRole("status")).toContainText(
    "Optional activity email is on.",
  );
  await page.screenshot({
    path: test.info().outputPath("optional-email-enabled.png"),
    fullPage: true,
  });
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.reload({ waitUntil: "networkidle" });
  await expect(
    preferences.getByRole("button", { name: "Turn off activity email" }),
  ).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  await expect(
    preferences.getByRole("button", { name: "Turn off activity email" }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("optional-email-zoom.png"),
    fullPage: true,
  });
  const disabledResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/notifications/email",
  );
  await preferences
    .getByRole("button", { name: "Turn off activity email" })
    .click();
  expect((await disabledResponse).status()).toBe(200);
  await expect(preferences.getByRole("status")).toContainText(
    "Optional activity email is off.",
  );
  await page.screenshot({
    path: test.info().outputPath("optional-email-disabled.png"),
    fullPage: true,
  });
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.reload({ waitUntil: "networkidle" });
  await expect(
    preferences.getByRole("button", { name: "Turn on activity email" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  expect(failures).toEqual([]);
  await context.close();
});
