/** Run only with actual retained component outputs; never fabricates VM/analyzer evidence. */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { assembleEvidence } from "../workers/vetting/assembly";

const [
  acquisitionDirectory,
  artifactDirectory,
  vmDirectory,
  outputDirectory,
  guestProfile,
  dependencyDirectory,
  dependencyFailureDirectory,
] = process.argv.slice(2);
if (
  !acquisitionDirectory ||
  !artifactDirectory ||
  !vmDirectory ||
  !outputDirectory
)
  throw new Error(
    "usage: bun scripts/vetting-assembly-workflow.ts ACQUISITION ARTIFACT_REPORTS VM_OUTPUT PRIVATE_OUTPUT_PARENT [APPROVED_GUEST_PROFILE_OR_DASH] [DEPENDENCY_DIRECTORY] [FAILED_DEPENDENCY_DIRECTORY]",
  );
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const artifactInventories = await Promise.all(
  (await readdir(join(acquisitionDirectory, "objects"))).map(
    async (sourceSha256) => {
      const path = join(artifactDirectory, `${sourceSha256}.json`);
      return { sourceSha256, path, sha256: digest(await readFile(path)) };
    },
  ),
);
const input = {
  acquisitionDirectory,
  queuedInputsSha256: digest(
    await readFile(join(acquisitionDirectory, "queued-inputs.json")),
  ),
  artifactInventories,
  vmEvidence: {
    directory: vmDirectory,
    sha256: digest(await readFile(join(vmDirectory, "evidence.json"))),
  },
  outputDirectory,
  dependencyEvidence: dependencyDirectory
    ? {
        directory: dependencyDirectory,
        inventorySha256: digest(
          await readFile(join(dependencyDirectory, "inventory.json")),
        ),
        profileSha256: digest(
          await readFile(join(dependencyDirectory, "profile.json")),
        ),
      }
    : undefined,
  guestEvidence:
    guestProfile && guestProfile !== "-"
      ? {
          profilePath: guestProfile,
          profileSha256: digest(await readFile(guestProfile)),
          collectorSha256: digest(
            await readFile(
              new URL("../workers/vetting/guest.py", import.meta.url),
            ),
          ),
          receiptSha256: digest(
            await readFile(join(vmDirectory, "guest-source-evidence.json")),
          ),
        }
      : undefined,
};
const result = await assembleEvidence(input);
const manifestBytes = await readFile(join(result.directory, "manifest.json"));
const reviewBytes = await readFile(join(result.directory, "review-input.json"));
assert.equal(digest(manifestBytes), result.manifestSha256);
assert.equal(digest(reviewBytes), result.inputManifestSha256);
const manifest = JSON.parse(manifestBytes.toString());
const review = JSON.parse(reviewBytes.toString());
assert.equal(manifest.state, "incomplete");
assert.equal(manifest.providerCallsAuthorized, false);
assert.equal(manifest.publicationAuthorized, false);
assert(
  review.visibilityGaps.includes(
    input.guestEvidence
      ? "only-approved-harmless-fixture-command-executed"
      : "acquired-source-not-executed",
  ),
);
assert(review.visibilityGaps.includes("complete-collector-not-attached"));
for (const item of review.items)
  assert.equal(digest(Buffer.from(item.text)), item.sha256);
const before = (await readdir(outputDirectory)).sort();
if (input.dependencyEvidence) {
  assert(
    review.visibilityGaps.includes(
      "dependency-prefetch-is-not-runtime-proxy-coverage",
    ),
  );
  assert(
    review.visibilityGaps.includes("dependencies-not-authorized-for-execution"),
  );
  assert(
    manifest.files.some(
      (file: { role: string }) => file.role === "dependency-inventory",
    ),
  );
  const supplied = input.dependencyEvidence;
  for (const key of ["inventorySha256", "profileSha256"] as const)
    await assert.rejects(
      assembleEvidence({
        ...input,
        dependencyEvidence: { ...supplied, [key]: "0".repeat(64) },
      }),
    );
  // Start from real retained fetch outputs; corrupt the copies only.
  const tampered = await mkdtemp(join(outputDirectory, "dependency-negative-"));
  try {
    const copy = join(tampered, "fetch");
    await cp(supplied.directory, copy, { recursive: true });
    const inventoryPath = join(copy, "inventory.json");
    const inventory = JSON.parse((await readFile(inventoryPath)).toString());
    const object = join(copy, inventory.records[0].objectPath);
    await rm(object);
    await writeFile(object, "changed captured dependency");
    await assert.rejects(
      assembleEvidence({
        ...input,
        dependencyEvidence: { ...supplied, directory: copy },
      }),
    );
    await rm(copy, { recursive: true });
    await cp(supplied.directory, copy, { recursive: true });
    const inspection = join(copy, inventory.records[0].inspectionPath);
    await rm(inspection);
    await assert.rejects(
      assembleEvidence({
        ...input,
        dependencyEvidence: { ...supplied, directory: copy },
      }),
    );
    inventory.sourceInventorySha256 = "0".repeat(64);
    const altered = Buffer.from(JSON.stringify(inventory));
    await rm(inventoryPath);
    await writeFile(inventoryPath, altered);
    await assert.rejects(
      assembleEvidence({
        ...input,
        dependencyEvidence: {
          ...supplied,
          directory: copy,
          inventorySha256: digest(altered),
        },
      }),
    );
    if (dependencyFailureDirectory) {
      const failure = await readFile(
        join(dependencyFailureDirectory, "failure.json"),
      );
      assert.equal(JSON.parse(failure.toString()).state, "incomplete");
      await assert.rejects(
        assembleEvidence({
          ...input,
          dependencyEvidence: {
            ...supplied,
            directory: dependencyFailureDirectory,
            inventorySha256: digest(failure),
          },
        }),
      );
    }
  } finally {
    await rm(tampered, { recursive: true, force: true });
  }
}
await assert.rejects(
  assembleEvidence({ ...input, queuedInputsSha256: "0".repeat(64) }),
);
if (input.guestEvidence) {
  for (const key of [
    "profileSha256",
    "collectorSha256",
    "receiptSha256",
  ] as const) {
    await assert.rejects(
      assembleEvidence({
        ...input,
        guestEvidence: { ...input.guestEvidence, [key]: "0".repeat(64) },
      }),
    );
  }
  assert(
    review.visibilityGaps.includes(
      "guest-receipt-not-independent-kernel-or-host-proof",
    ),
  );
  assert(
    review.visibilityGaps.includes(
      "complete-interpreter-jit-memory-and-proxy-interception-not-proven",
    ),
  );
}
await assert.rejects(assembleEvidence({ ...input, artifactInventories: [] }));
await assert.rejects(
  assembleEvidence({
    ...input,
    artifactInventories: artifactInventories.map((entry, index) =>
      index ? entry : { ...entry, sha256: "0".repeat(64) },
    ),
  }),
);
await assert.rejects(
  assembleEvidence({
    ...input,
    vmEvidence: { ...input.vmEvidence, sha256: "0".repeat(64) },
  }),
);
assert.deepEqual((await readdir(outputDirectory)).sort(), before);
console.log(
  JSON.stringify({
    ...result,
    state: "incomplete",
    providerCalls: 0,
    publications: 0,
    rejectedCorruptOrMissingInputs:
      (input.guestEvidence ? 7 : 4) +
      (dependencyDirectory
        ? 5 + Number(Boolean(dependencyFailureDirectory))
        : 0),
  }),
);
