/** Private evidence assembly. This does not authorize model spend or publication. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const hash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const HEX = /^[a-f0-9]{64}$/u;
type Row = Record<string, unknown>;
function record(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid evidence record");
  return value as Row;
}
function gaps(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some((gap) => typeof gap !== "string" || !gap || gap.length > 512)
  )
    throw new Error("Missing evidence coverage");
  return value as string[];
}
async function bytes(path: string, expected: string, maximum: number) {
  if (!HEX.test(expected)) throw new Error("Invalid evidence digest");
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximum)
      throw new Error("Evidence is not a bounded regular file");
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length <= maximum) {
      const read = await file.read(buffer, length, maximum + 1 - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const result = buffer.subarray(0, length);
    if (length > maximum || hash(result) !== expected)
      throw new Error("Evidence bytes changed");
    return result;
  } finally {
    await file.close();
  }
}

async function verifyLargeFile(path: string, expected: string) {
  if (!HEX.test(expected)) throw new Error("Invalid runtime disk digest");
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 2 * 1024 ** 3)
      throw new Error("Runtime disk exceeds limit");
    const digest = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let total = 0;
    while (true) {
      const read = await file.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) break;
      total += read.bytesRead;
      if (total > 2 * 1024 ** 3) throw new Error("Runtime disk exceeds limit");
      digest.update(buffer.subarray(0, read.bytesRead));
    }
    if (digest.digest("hex") !== expected)
      throw new Error("Runtime disk changed");
    return total;
  } finally {
    await file.close();
  }
}

/** Inputs are operator-held files from real acquisition, analyzer and VM components. */
export async function assembleEvidence(input: {
  acquisitionDirectory: string;
  queuedInputsSha256: string;
  artifactInventories: { sourceSha256: string; path: string; sha256: string }[];
  vmEvidence: { directory: string; sha256: string };
  outputDirectory: string;
}) {
  const queueBytes = await bytes(
    join(input.acquisitionDirectory, "queued-inputs.json"),
    input.queuedInputsSha256,
    1024 * 1024,
  );
  const queue = record(JSON.parse(queueBytes.toString("utf8")));
  if (queue.schema !== "slop-queued-inputs-v1" || queue.state !== "quarantined")
    throw new Error("Invalid acquisition state");
  const sourceBytes = await bytes(
    join(input.acquisitionDirectory, "inventory.json"),
    String(queue.sourceInventorySha256),
    1024 * 1024,
  );
  const source = record(JSON.parse(sourceBytes.toString("utf8")));
  const assessment = record(queue.assessment);
  if (
    source.schema !== "slop-source-inventory-v1" ||
    source.state !== "quarantined" ||
    source.commitSha !== assessment.commitSha
  )
    throw new Error("Source assessment mismatch");
  if (!Array.isArray(source.records) || !Array.isArray(queue.inputs))
    throw new Error("Missing source inventory");
  const visibility = new Set([
    ...gaps(queue.visibilityGaps),
    ...gaps(source.visibilityGaps).filter(
      (gap) => gap !== "skill-template-inputs-not-acquired",
    ),
    "acquired-source-not-executed",
    "complete-collector-not-attached",
    "artifact-release-not-authorized",
  ]);
  const items: { id: string; text: string; sha256: string }[] = [];
  const files: { role: string; sha256: string; bytes: number }[] = [];
  let total = 0;
  function add(id: string, value: Buffer) {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(value);
    total += value.length;
    if (total > 768 * 1024 || items.length >= 1000)
      throw new Error("Review inventory exceeds bounded complete-input limit");
    items.push({ id, text, sha256: hash(text) });
    files.push({ role: id, sha256: hash(value), bytes: value.length });
  }
  add("queue", queueBytes);
  add("source-inventory", sourceBytes);
  const objects = new Set<string>();
  for (const value of [...source.records, ...queue.inputs]) {
    const entry = record(value);
    if (entry.sha256 === null && entry.type === "commit") continue;
    if (
      typeof entry.sha256 !== "string" ||
      !HEX.test(entry.sha256) ||
      entry.state !== "quarantined"
    )
      throw new Error("Invalid source object");
    objects.add(entry.sha256);
  }
  const inventories = new Map<
    string,
    (typeof input.artifactInventories)[number]
  >();
  for (const inventory of input.artifactInventories) {
    if (
      !objects.has(inventory.sourceSha256) ||
      inventories.has(inventory.sourceSha256)
    )
      throw new Error("Unexpected or duplicate artifact inventory");
    inventories.set(inventory.sourceSha256, inventory);
  }
  for (const sha256 of objects) {
    const content = await bytes(
      join(input.acquisitionDirectory, "objects", sha256),
      sha256,
      8 * 1024 * 1024,
    );
    try {
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        content,
      );
    } catch {
      visibility.add("binary-source-bytes-not-readable-by-model");
    }
    if (!content.includes(0)) {
      try {
        add(`object:${sha256}`, content);
      } catch (error) {
        if (error instanceof TypeError)
          visibility.add("binary-source-bytes-not-readable-by-model");
        else throw error;
      }
    } else visibility.add("binary-source-bytes-not-readable-by-model");
    files.push({
      role: `acquired-object:${sha256}`,
      sha256,
      bytes: content.length,
    });
    const supplied = inventories.get(sha256);
    if (!supplied)
      throw new Error(
        "Every acquired object requires isolated artifact inspection",
      );
    const inventoryBytes = await bytes(
      supplied.path,
      supplied.sha256,
      2 * 1024 * 1024,
    );
    const inventory = record(JSON.parse(inventoryBytes.toString("utf8")));
    if (
      inventory.schema !== "slop-artifact-inventory-v1" ||
      inventory.state !== "quarantined" ||
      !Array.isArray(inventory.records) ||
      record(inventory.records[0]).sha256 !== sha256 ||
      inventory.records.some((row) => record(row).state !== "quarantined")
    )
      throw new Error("Artifact inspection does not bind source");
    if (inventory.records.length > 1)
      visibility.add("nested-artifact-content-not-supplied-to-models");
    for (const gap of gaps(inventory.visibilityGaps)) visibility.add(gap);
    add(`artifact:${sha256}`, inventoryBytes);
  }
  const vmBytes = await bytes(
    join(input.vmEvidence.directory, "evidence.json"),
    input.vmEvidence.sha256,
    1024 * 1024,
  );
  const vm = record(JSON.parse(vmBytes.toString("utf8")));
  if (
    vm.schema !== "slop-offline-vm-evidence-v1" ||
    vm.state !== "incomplete" ||
    vm.network !== "no-network-device"
  )
    throw new Error("Unsupported runtime evidence profile");
  for (const gap of gaps(vm.visibilityGaps)) visibility.add(gap);
  add("offline-vm", vmBytes);
  const serial = await bytes(
    join(input.vmEvidence.directory, "serial.log"),
    String(vm.serialSha256),
    4 * 1024 * 1024,
  );
  // Serial is hostile text. Invalid UTF-8 fails rather than silently changing evidence.
  add("untrusted-vm-serial", serial);
  for (const [name, digest] of [
    ["overlay.qcow2", vm.overlaySha256],
    ["disk-map.json", vm.diskMapSha256],
  ] as const) {
    // Verify the small map; the large overlay remains operator evidence, not model input.
    if (name === "disk-map.json")
      add(
        "block-allocation-map",
        await bytes(
          join(input.vmEvidence.directory, name),
          String(digest),
          4 * 1024 * 1024,
        ),
      );
    else
      files.push({
        role: "runtime-overlay",
        sha256: String(digest),
        bytes: await verifyLargeFile(
          join(input.vmEvidence.directory, name),
          String(digest),
        ),
      });
  }
  const review = Buffer.from(
    JSON.stringify({ items, visibilityGaps: [...visibility].sort() }),
  );
  if (review.length > 1024 * 1024 || visibility.size > 100)
    throw new Error("Complete review exceeds provider input bound");
  const directory = await mkdtemp(
    join(input.outputDirectory, "slop-evidence-"),
  );
  try {
    await writeFile(join(directory, "review-input.json"), review, {
      flag: "wx",
      mode: 0o400,
    });
    const manifest = Buffer.from(
      JSON.stringify({
        schema: "slop-evidence-assembly-v1",
        assessment,
        queuedInputsSha256: input.queuedInputsSha256,
        reviewInputSha256: hash(review),
        files,
        runtimeOverlaySha256: vm.overlaySha256,
        state: "incomplete",
        providerCallsAuthorized: false,
        publicationAuthorized: false,
        visibilityGaps: [...visibility].sort(),
      }),
    );
    await writeFile(join(directory, "manifest.json"), manifest, {
      flag: "wx",
      mode: 0o400,
    });
    return {
      directory,
      inputManifestSha256: hash(review),
      manifestSha256: hash(manifest),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
