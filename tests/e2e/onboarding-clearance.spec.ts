/** The agent prompt is always available; it never waits on discovery. */
import { expect, test } from "@playwright/test";

test("agent setup always shows the copyable prompt", async ({
  page,
  context,
}, info) => {
  let discoveryRequests = 0;
  await page.route("**/.well-known/slop/projects.json", (route) => {
    discoveryRequests += 1;
    return route.fulfill({ status: 503, body: "" });
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/projects/eliza", { waitUntil: "networkidle" });
  await expect(
    page.getByRole("status", { name: "Agent prompt" }),
  ).toContainText("elizaOS/eliza");
  await page.getByRole("button", { name: "Copy agent prompt" }).click();
  await expect(page.getByRole("button", { name: /Copied/u })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    "elizaOS/eliza",
  );
  await expect(page.getByText("inbound terms")).toHaveCount(0);
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(
    page.getByRole("status", { name: "Agent prompt" }),
  ).toContainText("/SKILL.md");
  expect(discoveryRequests).toBe(0);
  await page.screenshot({
    path: info.outputPath("home-agent-setup.png"),
    fullPage: true,
  });
});

test("home agent setup stays usable when discovery is unavailable", async ({
  page,
  context,
}) => {
  await page.route("**/.well-known/slop/projects.json", (route) =>
    route.fulfill({ status: 503, body: "Unavailable" }),
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Copy agent prompt" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    "/SKILL.md",
  );
  await expect(
    page.getByRole("heading", { name: "Agent setup unavailable" }),
  ).toHaveCount(0);
});
