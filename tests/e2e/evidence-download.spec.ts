/** Actual Pages/D1/R2 signed transport and native browser attachment workflow. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { applicationManifest } from "../project-application-manifest";
import { signedVettingHeaders } from "../vetting-fixtures";

test("large private evidence downloads with a single-use browser grant @registry", async ({
  page,
  request,
  baseURL,
}, info) => {
  const origin = new URL(baseURL!).origin;
  const errors: string[] = [],
    failures: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("requestfailed", (req) => {
    if (new URL(req.url()).origin === origin)
      failures.push(
        `${req.method()} ${new URL(req.url()).pathname}: ${req.failure()?.errorText}`,
      );
  });
  const suffix = info.project.name.replaceAll(/[^a-z0-9-]/g, "-");
  const project = `large-evidence-${suffix}`;
  const api = (path: string, body: unknown, admin = false) =>
    request.post(`/api/v1/${path}`, {
      headers: {
        origin,
        cookie: `__Host-slop_points=${process.env[admin ? "SLOP_E2E_ADMIN_TOKEN" : "SLOP_E2E_APPLICANT_TOKEN"]}`,
      },
      data: body,
    });
  const submitted = await api("project-applications", {
    manifest: applicationManifest(project, `example/open-registry-${suffix}`),
  });
  expect(submitted.status()).toBe(201);
  const application = (await submitted.json()).application;
  expect(
    (
      await api(
        `admin/project-applications/${application.id}/approve`,
        {},
        true,
      )
    ).status(),
  ).toBe(200);
  const queued = await api(
    "admin/vetting/assessments",
    {
      projectId: project,
      revision: 1,
      reason: "Inspect large retained synthetic evidence",
    },
    true,
  );
  expect(queued.status()).toBe(201);
  const assessment = (await queued.json()).assessment.id,
    runId = "large-evidence";
  const bytes = process.env.SLOP_VETTING_OVERLAY_PATH
    ? await readFile(process.env.SLOP_VETTING_OVERLAY_PATH)
    : Buffer.alloc(23_592_960, 71);
  const digest = (data: Uint8Array) =>
    createHash("sha256").update(data).digest("hex");
  const sha = digest(bytes),
    limit = 8 * 1024 * 1024;
  const chunks = [];
  for (let at = 0; at < bytes.length; at += limit) {
    const part = bytes.subarray(at, at + limit);
    chunks.push({
      index: chunks.length,
      sha256: digest(part),
      sizeBytes: part.length,
    });
  }
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    Buffer.from(process.env.SLOP_E2E_VETTING_PRIVATE_KEY!, "base64"),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const publicKey = Buffer.from(
    process.env.SLOP_E2E_VETTING_PUBLIC_KEY!,
    "base64",
  );
  const send = async (
    method: string,
    path: string,
    body: string | Uint8Array,
  ) =>
    request.fetch(path, {
      method,
      data: Buffer.from(body),
      headers: await signedVettingHeaders(
        privateKey,
        publicKey,
        method,
        path,
        body,
      ),
    });
  const base = `/api/v1/vetting/evidence/${assessment}/${runId}`;
  const manifest = JSON.stringify({
    traceSha256: sha,
    objects: [
      {
        sha256: sha,
        sizeBytes: bytes.length,
        kind: "disk-diff",
        label: "Synthetic VM disk overlay",
        contentType: "application/octet-stream",
        chunks,
      },
    ],
  });
  // The trace and disk bytes are the same immutable object in this transport fixture.
  const parsed = JSON.parse(manifest);
  parsed.objects[0].kind = "trace";
  expect((await send("POST", base, JSON.stringify(parsed))).status()).toBe(201);
  for (const part of chunks)
    expect(
      (
        await send(
          "PUT",
          `${base}/${sha}/chunks/${part.index}`,
          bytes.subarray(
            part.index * limit,
            part.index * limit + part.sizeBytes,
          ),
        )
      ).status(),
    ).toBe(200);
  expect((await send("POST", `${base}/${sha}/finalize`, "{}")).status()).toBe(
    200,
  );
  await page.goto("/how-it-works", { waitUntil: "networkidle" });
  await page.evaluate((token) => {
    document.cookie = `__Host-slop_points=${token}; Path=/; Secure; SameSite=Strict`;
  }, process.env.SLOP_E2E_OWNER_TOKEN!);
  await page.goto(
    `/vetting-evidence?assessmentId=${assessment}&runId=${runId}`,
    { waitUntil: "networkidle" },
  );
  await page
    .getByRole("button", { name: "Inspect evidence inventory" })
    .click();
  const item = page
    .getByRole("article")
    .filter({
      has: page.getByRole("heading", {
        name: "Synthetic VM disk overlay",
        exact: true,
      }),
    });
  await item
    .getByRole("textbox")
    .fill("Inspect the complete synthetic disk overlay without execution");
  await item.getByRole("button").focus();
  const downloadPromise = page.waitForEvent("download");
  await page.keyboard.press("Enter");
  const downloaded = await downloadPromise;
  const file = info.outputPath("retained-overlay.qcow2");
  await downloaded.saveAs(file);
  expect(await downloaded.failure()).toBeNull();
  expect(digest(await readFile(file))).toBe(sha);
  await expect(item.getByRole("status")).toContainText("Download requested.");
  const cookies = await page.context().cookies();
  expect(
    cookies.some((cookie) => cookie.name === "__Secure-vetting-read-grant"),
  ).toBe(false);
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({
    path: info.outputPath("large-evidence-zoom.png"),
    fullPage: true,
  });
  await page.evaluate(() => {
    document.documentElement.style.zoom = "1";
    scrollTo(0, 0);
  });
  await page.screenshot({
    path: info.outputPath("large-evidence.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
  expect(failures).toEqual([]);
  const video = page.video();
  await page.close();
  if (video)
    await video.saveAs(info.outputPath("large-evidence-walkthrough.webm"));
});
