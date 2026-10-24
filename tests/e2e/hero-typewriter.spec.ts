import { expect, test } from "@playwright/test";

test("hero types, deletes and cycles all original campaign phrases without moving the layout", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.clock.install();
  await page.goto("/");
  const heading = page.getByRole("heading", { level: 1 });
  const text = heading.locator(".hero-typewriter");
  await expect(text).toHaveText("SHIPPING OPEN SOURCE.");
  const before = await heading.boundingBox();
  for (const next of [
    "SECURING THE WEB.",
    "HACKING THE PLANET.",
    "BUILDING AGI.",
    "SHIPPING OPEN SOURCE.",
  ]) {
    const current = (await text.textContent()) ?? "";
    await page.clock.runFor(2430);
    await expect(text).not.toHaveText(current);
    await page.clock.runFor(30 * (current.length - 1) + 220);
    await expect(text).toHaveText("");
    await page.clock.runFor(55);
    await expect(text).toHaveText(next.slice(0, 1));
    await page.clock.runFor(55 * (next.length - 1) + 1);
    await expect(text).toHaveText(next);
    await expect(heading).toHaveAccessibleName(
      "MAKE MONEY SHIPPING OPEN SOURCE.",
    );
    expect((await heading.boundingBox())?.height).toBe(before?.height);
  }
});

test("reduced motion keeps the hero static", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install();
  await page.goto("/");
  const text = page.locator(".hero-typewriter");
  await expect(text).toHaveText("SHIPPING OPEN SOURCE.");
  await page.clock.runFor(30_000);
  await expect(text).toHaveText("SHIPPING OPEN SOURCE.");
  await expect(page.locator(".hero-typewriter-caret")).toBeHidden();
});
