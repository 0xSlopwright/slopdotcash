/** Run only with actual retained component outputs; never fabricates VM/analyzer evidence. */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { assembleEvidence } from "../workers/vetting/assembly";

const [acquisitionDirectory, artifactDirectory, vmDirectory, outputDirectory] =
  process.argv.slice(2);
if (
  !acquisitionDirectory ||
  !artifactDirectory ||
  !vmDirectory ||
  !outputDirectory
)
  throw new Error(
    "usage: bun scripts/vetting-assembly-workflow.ts ACQUISITION ARTIFACT_REPORTS VM_OUTPUT PRIVATE_OUTPUT_PARENT",
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
assert(review.visibilityGaps.includes("acquired-source-not-executed"));
assert(review.visibilityGaps.includes("complete-collector-not-attached"));
for (const item of review.items)
  assert.equal(digest(Buffer.from(item.text)), item.sha256);
const before = (await readdir(outputDirectory)).sort();
await assert.rejects(
  assembleEvidence({ ...input, queuedInputsSha256: "0".repeat(64) }),
);
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
    rejectedCorruptOrMissingInputs: 4,
  }),
);
