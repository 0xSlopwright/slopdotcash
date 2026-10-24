/** Exercises the start control's public discovery contract, not VM clearance. */
import { expect, test } from "@playwright/test";

test("agent setup shows only for a discoverable project", async ({
  page,
  context,
}, info) => {
  let state: "unavailable" | "blocked" | "cleared" = "unavailable";
  await page.route("**/.well-known/slop/projects.json", (route) =>
    route.fulfill({
      // Invalid response bodies can occur when a static host substitutes index.html.
      ...(state === "unavailable"
        ? { contentType: "text/html", body: "<html>Unavailable</html>" }
        : {
            json: {
              schemaVersion: "1",
              projects: state === "blocked" ? [] : [{ project_id: "eliza" }],
            },
          }),
    }),
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  for (const hidden of ["unavailable", "blocked"] as const) {
    state = hidden;
    await page.goto("/projects/eliza", { waitUntil: "networkidle" });
    await expect(
      page.getByRole("button", { name: "Copy agent prompt" }),
    ).toHaveCount(0);
    await expect(page.locator(".install-panel")).toHaveCount(0);
  }
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.locator(".home-agent-setup")).toHaveCount(0);
  state = "cleared";
  await page.goto("/projects/eliza", { waitUntil: "networkidle" });
  await expect(
    page.getByRole("status", { name: "Agent prompt" }),
  ).toContainText("elizaOS/eliza");
  await page.getByRole("button", { name: "Copy agent prompt" }).click();
  await expect(page.getByRole("button", { name: /Copied/u })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    "elizaOS/eliza",
  );
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(
    page.getByRole("status", { name: "Agent prompt" }),
  ).toContainText("/SKILL.md");
  await page.screenshot({
    path: info.outputPath("home-agent-setup.png"),
    fullPage: true,
  });
});
