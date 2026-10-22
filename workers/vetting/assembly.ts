/** Private evidence assembly. This does not authorize model spend or publication. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseAssemblyManifest } from "./assembly-manifest";
import { indexSyscalls, syscallEvidence } from "./events";

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
  guestEvidence?: {
    profilePath: string;
    profileSha256: string;
    collectorSha256: string;
    receiptSha256: string;
  };
  dependencyEvidence?: {
    directory: string;
    inventorySha256: string;
    profileSha256: string;
  };
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
  let structuredTrace: Buffer | undefined;
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
  async function inspectedObject(
    sha256: string,
    objectPath: string,
    supplied: { path: string; sha256: string },
    dependency = false,
  ) {
    const content = await bytes(objectPath, sha256, 8 * 1024 * 1024);
    try {
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        content,
      );
    } catch {
      visibility.add(
        dependency
          ? "binary-dependency-bytes-not-readable-by-model"
          : "binary-source-bytes-not-readable-by-model",
      );
    }
    if (!content.includes(0)) {
      try {
        add(
          `${dependency ? "dependency-object" : "object"}:${sha256}`,
          content,
        );
      } catch (error) {
        if (error instanceof TypeError)
          visibility.add(
            dependency
              ? "binary-dependency-bytes-not-readable-by-model"
              : "binary-source-bytes-not-readable-by-model",
          );
        else throw error;
      }
    } else
      visibility.add(
        dependency
          ? "binary-dependency-bytes-not-readable-by-model"
          : "binary-source-bytes-not-readable-by-model",
      );
    files.push({
      role: `${dependency ? "dependency-object-bytes" : "acquired-object"}:${sha256}`,
      sha256,
      bytes: content.length,
    });
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
    add(
      `${dependency ? "dependency-artifact" : "artifact"}:${sha256}`,
      inventoryBytes,
    );
  }
  for (const sha256 of objects) {
    const supplied = inventories.get(sha256);
    if (!supplied)
      throw new Error(
        "Every acquired object requires isolated artifact inspection",
      );
    await inspectedObject(
      sha256,
      join(input.acquisitionDirectory, "objects", sha256),
      supplied,
    );
  }
  if (input.dependencyEvidence) {
    const supplied = input.dependencyEvidence;
    const inventoryBytes = await bytes(
      join(supplied.directory, "inventory.json"),
      supplied.inventorySha256,
      1024 * 1024,
    );
    const inventory = record(JSON.parse(inventoryBytes.toString("utf8")));
    const profileBytes = await bytes(
      join(supplied.directory, "profile.json"),
      supplied.profileSha256,
      65536,
    );
    const profile = record(JSON.parse(profileBytes.toString("utf8")));
    if (
      inventory.schema !== "slop-dependency-inventory-v1" ||
      inventory.state !== "quarantined" ||
      inventory.executionAuthorized !== false ||
      inventory.sourceInventorySha256 !== queue.sourceInventorySha256 ||
      inventory.profileSha256 !== supplied.profileSha256 ||
      profile.schema !== "slop-dependency-fetch-profile-v1" ||
      profile.sourceInventorySha256 !== queue.sourceInventorySha256 ||
      profile.caBundleSha256 !== inventory.caBundleSha256 ||
      !HEX.test(String(profile.caBundleSha256)) ||
      !Array.isArray(profile.dependencies) ||
      !profile.dependencies.length ||
      profile.dependencies.length > 16 ||
      !Array.isArray(inventory.records) ||
      inventory.records.length !== profile.dependencies.length
    )
      throw new Error(
        "Dependency evidence does not bind approved source/profile",
      );
    for (const gap of gaps(inventory.visibilityGaps)) visibility.add(gap);
    visibility.add("dependency-prefetch-is-not-runtime-proxy-coverage");
    visibility.add("dependencies-not-authorized-for-execution");
    add("dependency-profile", profileBytes);
    add("dependency-inventory", inventoryBytes);
    let budget = 0;
    const urls = new Set<string>();
    const inspected = new Map<string, string>();
    for (let index = 0; index < inventory.records.length; index++) {
      const entry = record(inventory.records[index]);
      const approved = record(profile.dependencies[index]);
      if (
        entry.dependencyIndex !== index ||
        typeof entry.sha256 !== "string" ||
        !HEX.test(entry.sha256) ||
        entry.sha256 !== approved.sha256 ||
        typeof approved.url !== "string" ||
        urls.has(approved.url) ||
        entry.url !== approved.url ||
        entry.state !== "quarantined" ||
        entry.status !== 200 ||
        !Number.isSafeInteger(approved.maxBytes) ||
        Number(approved.maxBytes) < 1 ||
        Number(approved.maxBytes) > 8 * 1024 * 1024 ||
        !Number.isSafeInteger(entry.bytes) ||
        Number(entry.bytes) < 0 ||
        Number(entry.bytes) > Number(approved.maxBytes) ||
        typeof entry.inspectionSha256 !== "string" ||
        !HEX.test(entry.inspectionSha256) ||
        (inspected.has(entry.sha256) &&
          inspected.get(entry.sha256) !== entry.inspectionSha256) ||
        entry.objectPath !== `objects/${entry.sha256}` ||
        entry.inspectionPath !== `inspections/${entry.sha256}.json`
      )
        throw new Error(
          "Dependency record differs from reviewed fetch profile",
        );
      urls.add(approved.url);
      budget += Number(approved.maxBytes);
      if (budget > 32 * 1024 * 1024)
        throw new Error("Dependency evidence exceeds run bound");
      const objectPath = join(supplied.directory, "objects", entry.sha256);
      const content = await bytes(objectPath, entry.sha256, 8 * 1024 * 1024);
      if (content.length !== entry.bytes)
        throw new Error("Dependency size changed");
      if (!inspected.has(entry.sha256)) {
        await inspectedObject(
          entry.sha256,
          objectPath,
          {
            path: join(
              supplied.directory,
              "inspections",
              `${entry.sha256}.json`,
            ),
            sha256: String(entry.inspectionSha256),
          },
          true,
        );
        inspected.set(entry.sha256, entry.inspectionSha256);
      }
    }
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
  // Serial is hostile text. Invalid UTF-8 fails rather than changing evidence.
  if (input.guestEvidence) {
    const expected = input.guestEvidence;
    const profileBytes = await bytes(
      expected.profilePath,
      expected.profileSha256,
      65536,
    );
    const profile = record(JSON.parse(profileBytes.toString("utf8")));
    const receiptBytes = await bytes(
      join(input.vmEvidence.directory, "guest-source-evidence.json"),
      expected.receiptSha256,
      1024 * 1024,
    );
    const receipt = record(JSON.parse(receiptBytes.toString("utf8")));
    const sourceDigests = [
      ...new Set(source.records.map((row) => String(record(row).sha256))),
    ].sort();
    if (
      profile.schema !== "slop-harmless-guest-profile-v1" ||
      profile.fixtureOnly !== true ||
      profile.sourceInventorySha256 !== queue.sourceInventorySha256 ||
      receipt.schema !== "slop-guest-syscall-evidence-v1" ||
      receipt.state !== "incomplete" ||
      receipt.fixtureOnly !== true ||
      receipt.profileSha256 !== expected.profileSha256 ||
      receipt.sourceInventorySha256 !== queue.sourceInventorySha256 ||
      JSON.stringify(receipt.sourceSha256) !== JSON.stringify(sourceDigests) ||
      receipt.vmEvidenceSha256 !== input.vmEvidence.sha256 ||
      vm.exitCode !== 0 ||
      receipt.serialSha256 !== vm.serialSha256 ||
      receipt.seedSha256 !== vm.seedSha256 ||
      !HEX.test(expected.collectorSha256) ||
      receipt.collectorSha256 !== expected.collectorSha256 ||
      receipt.providerCallsAuthorized !== false ||
      receipt.publicationAuthorized !== false
    )
      throw new Error(
        "Guest receipt does not bind this approved source and VM",
      );
    const serialText = new TextDecoder("utf-8", { fatal: true }).decode(serial);
    const prefix = "SLOP_GUEST_EVIDENCE_V1:";
    const lines = serialText.split("\n");
    const frames = lines.filter((line) => line.startsWith(prefix));
    if (frames.length !== 1)
      throw new Error("Missing or ambiguous guest serial frame");
    const encoded = frames[0].slice(prefix.length).replace(/\r$/u, "");
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.toString("base64") !== encoded)
      throw new Error("Invalid guest frame encoding");
    const frame = record(JSON.parse(decoded.toString("utf8")));
    if (
      frame.schema !== receipt.schema ||
      frame.state !== "incomplete" ||
      frame.fixtureOnly !== true ||
      frame.exitCode !== receipt.exitCode ||
      JSON.stringify(frame.sourceSha256) !== JSON.stringify(sourceDigests) ||
      frame.profileSha256 !== receipt.profileSha256 ||
      frame.sourceInventorySha256 !== receipt.sourceInventorySha256 ||
      frame.traceSha256 !== receipt.traceSha256 ||
      frame.outputSha256 !== receipt.outputSha256
    )
      throw new Error("Guest frame and retained receipt differ");
    for (const [field, name] of [
      ["trace", "guest-events.log"],
      ["output", "guest-output.log"],
    ] as const) {
      const content = await bytes(
        join(input.vmEvidence.directory, name),
        String(receipt[`${field}Sha256`]),
        field === "trace" ? 1024 * 1024 : 65536,
      );
      if (
        typeof frame[field] !== "string" ||
        !Buffer.from(frame[field], "base64").equals(content)
      )
        throw new Error("Retained guest output differs from actual serial");
      add(`untrusted-${field}`, content);
      if (field === "trace") {
        if (
          !Number.isInteger(receipt.exitCode) ||
          typeof receipt.termination !== "string" ||
          typeof vm.termination !== "string"
        )
          throw new Error("Guest collector termination evidence is missing");
        const indexed = indexSyscalls(content, {
          expectedSha256: String(receipt.traceSha256),
          collectorExitCode: Number(receipt.exitCode),
          collectorTermination: receipt.termination,
          vmTermination: vm.termination,
        });
        const structured = syscallEvidence(indexed);
        structuredTrace = structured.bytes;
        files.push({
          role: "syscall-index",
          sha256: structured.indexSha256,
          bytes: structured.bytes.length,
        });
        add("syscall-review", structured.review);
        const summary = record(JSON.parse(structured.review.toString("utf8")));
        for (const gap of gaps(summary.visibilityGaps)) visibility.add(gap);
      }
    }
    if (profile.kernelPolicySha256 !== undefined) {
      const kernel = record(receipt.kernelArtifactGate);
      const rawKernel = record(frame.kernelArtifactGate);
      if (
        kernel.policySha256 !== profile.kernelPolicySha256 ||
        rawKernel.policySha256 !== profile.kernelPolicySha256 ||
        typeof rawKernel.postCollectorOutput !== "string"
      )
        throw new Error("Kernel fixture profile mismatch");
      const after = await bytes(
        join(input.vmEvidence.directory, "guest-after-collector.log"),
        String(kernel.postCollectorOutputSha256),
        65536,
      );
      if (!Buffer.from(rawKernel.postCollectorOutput, "base64").equals(after))
        throw new Error("Post-collector evidence differs from actual serial");
      add("untrusted-post-collector-probe", after);
    }
    // Preserve the complete raw serial digest while avoiding a second encoded
    // copy of the same private trace in the bounded model input.
    files.push({
      role: "raw-vm-serial",
      sha256: hash(serial),
      bytes: serial.length,
    });
    add(
      "untrusted-vm-console",
      Buffer.from(lines.filter((line) => line !== frames[0]).join("\n")),
    );
    add("approved-fixture-profile", profileBytes);
    add("guest-receipt", receiptBytes);
    for (const gap of gaps(receipt.visibilityGaps)) visibility.add(gap);
    visibility.delete("acquired-source-not-executed");
    for (const gap of [
      "only-approved-harmless-fixture-command-executed",
      "guest-receipt-not-independent-kernel-or-host-proof",
      "complete-interpreter-jit-memory-and-proxy-interception-not-proven",
    ])
      visibility.add(gap);
  } else add("untrusted-vm-serial", serial);
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
    if (structuredTrace)
      await writeFile(join(directory, "syscall-index.json"), structuredTrace, {
        flag: "wx",
        mode: 0o400,
      });
    await writeFile(join(directory, "review-input.json"), review, {
      flag: "wx",
      mode: 0o400,
    });
    const manifest = Buffer.from(
      JSON.stringify(
        parseAssemblyManifest({
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
      ),
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
