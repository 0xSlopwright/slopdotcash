import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyCurrentEscrowDeployment } from "./escrow-review";

test("unsigned planning verifies current and immutable D1 policy without legacy project files", async () => {
  const root = await mkdtemp(join(tmpdir(), "slop-escrow-registry-"));
  const project = JSON.parse(
    await readFile("tests/fixtures/projects/eliza.json", "utf8"),
  );
  project.reward.feeBasisPoints = 200;
  project.reward.chain = "base";
  project.escrow = {
    schemaVersion: "1",
    effectiveCycle: "2026-11",
    chain: "base",
    feeBasisPoints: 200,
    withdrawalFeeBasisPoints: 200,
    feeMode: "deduct-from-gross",
    deployments: [],
  };
  const manifestText = JSON.stringify(project);
  const manifestSha256 = createHash("sha256")
    .update(manifestText)
    .digest("hex");
  const row = {
    projectId: project.id,
    revision: 1,
    manifestSha256,
    manifest: project,
  };
  const archiveDirectory = join(root, "archive");
  await mkdir(join(root, "src/lib"), { recursive: true });
  await mkdir(archiveDirectory);
  await writeFile(
    join(root, "src/lib/project-revisions.generated.json"),
    JSON.stringify([row]),
  );
  await writeFile(join(archiveDirectory, "project.json"), manifestText);
  const input = {
    root,
    projectId: project.id,
    currentProject: project,
    archiveDirectory,
  };
  let live = { schemaVersion: "1", revision: 1, manifestSha256, project };
  let immutable = {
    schemaVersion: "1",
    projectId: project.id,
    revision: 1,
    manifestSha256,
    manifestText,
  };
  let status = 200;
  const requests: string[] = [];
  const transport = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (request: URL | RequestInfo) => {
        const url = String(request);
        requests.push(url);
        if (url === `https://slop.cash/api/v1/projects/${project.id}`)
          return Response.json(live, { status });
        if (
          url === `https://slop.cash/api/v1/project-revisions/${project.id}/1`
        )
          return Response.json(immutable);
        throw new Error(`Unexpected evidence request: ${url}`);
      },
      { preconnect: fetch.preconnect },
    ),
  );
  try {
    expect(await verifyCurrentEscrowDeployment(input)).toEqual({
      url: `https://slop.cash/api/v1/project-revisions/${project.id}/1`,
      revision: 1,
      sha256: manifestSha256,
    });
    expect(requests).toHaveLength(2);
    live = { ...live, revision: 2 };
    await expect(verifyCurrentEscrowDeployment(input)).rejects.toThrow(
      "differs from the synced policy",
    );
    live = { ...live, revision: 1 };
    immutable = { ...immutable, manifestText: `${manifestText}\n` };
    await expect(verifyCurrentEscrowDeployment(input)).rejects.toThrow(
      "differs from the synced policy",
    );
    immutable = { ...immutable, manifestText };
    status = 410;
    await expect(verifyCurrentEscrowDeployment(input)).rejects.toThrow(
      "unavailable (410)",
    );
    status = 200;
    const archived = structuredClone(project);
    archived.escrow.effectiveCycle = "2026-10";
    await writeFile(
      join(archiveDirectory, "project.json"),
      JSON.stringify(archived),
    );
    await expect(verifyCurrentEscrowDeployment(input)).rejects.toThrow(
      "financial policy differs",
    );
    await writeFile(join(archiveDirectory, "project.json"), manifestText);
    await writeFile(
      join(root, "src/lib/project-revisions.generated.json"),
      JSON.stringify([{ ...row, manifestSha256: "0".repeat(64) }]),
    );
    await expect(verifyCurrentEscrowDeployment(input)).rejects.toThrow(
      "do not match their D1 digest",
    );
  } finally {
    transport.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
