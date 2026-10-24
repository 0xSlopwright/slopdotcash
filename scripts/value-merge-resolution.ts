/** Read immutable objects only. Reconstruct in a new bare repository so local
 * hooks, merge drivers, filters and configuration cannot affect the result.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ValueEvidence } from "../workers/slopbot/value-evidence";
import type { ValueMergeResolution } from "../workers/slopbot/value-merge-resolution";

export async function collectMergeResolutions(
  evidence: ValueEvidence,
  repository: string,
): Promise<ValueEvidence> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_TERMINAL_PROMPT = "0";
  const objects = execFileSync(
    "git",
    [
      "-C",
      repository,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "objects",
    ],
    { env, encoding: "utf8" },
  ).trim();
  env.GIT_ALTERNATE_OBJECT_DIRECTORIES = objects;
  const directory = await mkdtemp(join(tmpdir(), "slop-value-merge-"));
  const resolutions: ValueMergeResolution[] = [];
  const gitVersion = execFileSync("git", ["--version"], {
    env,
    encoding: "utf8",
  }).trim();
  try {
    execFileSync("git", ["init", "--bare", "--template=", directory], {
      env,
      stdio: "ignore",
    });
    const git = (...args: string[]) =>
      spawnSync("git", ["--git-dir", directory, ...args], {
        env,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
    const read = (...args: string[]) => {
      const result = git(...args);
      if (result.status !== 0)
        throw new Error("Complete local Git evidence unavailable");
      return result.stdout;
    };
    const acceptedPaths = new Set(evidence.files.map((file) => file.filename));
    const authoredPaths = new Set(
      evidence.commitAttribution.flatMap((entry) => entry.changedPaths ?? []),
    );
    const entryAt = (ref: string, path: string) =>
      read("ls-tree", "-z", ref, "--", `:(literal)${path}`)
        .split("\0")
        .find((entry) => entry.split("\t")[1] === path)
        ?.split("\t")[0];
    for (const commit of evidence.commits) {
      if (commit.parents.length !== 2) continue;
      if (
        ![commit.sha, ...commit.parents.map((parent) => parent.sha)].every(
          (sha) => /^[a-f0-9]{40}$/u.test(sha),
        )
      )
        throw new Error("Invalid immutable merge identity");
      const parents = commit.parents.map((parent) => parent.sha) as [
        string,
        string,
      ];
      if (
        read("show", "-s", "--format=%P", commit.sha).trim() !==
        parents.join(" ")
      )
        throw new Error("Local merge parents differ from GitHub evidence");
      const merged = git(
        "merge-tree",
        "--write-tree",
        "--no-messages",
        ...parents,
      );
      if (merged.status !== 0 && merged.status !== 1)
        throw new Error("Automatic merge reconstruction failed");
      const automaticTree = merged.stdout.split("\n")[0];
      if (!/^[a-f0-9]{40}$/u.test(automaticTree))
        throw new Error("Automatic merge tree missing");
      const resolvedTree = read("rev-parse", `${commit.sha}^{tree}`).trim();
      const patch = read(
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--binary",
        "--no-renames",
        automaticTree,
        resolvedTree,
        "--",
      );
      const paths = read(
        "diff",
        "--name-only",
        "-z",
        "--no-renames",
        automaticTree,
        resolvedTree,
        "--",
      )
        .split("\0")
        .filter(Boolean);
      const automaticRelocations: NonNullable<
        ValueMergeResolution["automaticRelocations"]
      > = [];
      for (const sourceParent of parents) {
        const rows = read(
          "diff",
          "--raw",
          "-z",
          "--no-abbrev",
          "--no-ext-diff",
          "--no-textconv",
          "--find-renames=100%",
          "--diff-filter=R",
          sourceParent,
          automaticTree,
          "--",
        ).split("\0");
        for (let index = 0; index < rows.length - 1; index += 3) {
          const [oldMode, newMode, oldBlob, newBlob, status] = rows[index]
            .slice(1)
            .split(" ");
          const sourcePath = rows[index + 1];
          const path = rows[index + 2];
          if (
            status !== "R100" ||
            oldMode !== newMode ||
            oldBlob !== newBlob ||
            !acceptedPaths.has(path) ||
            authoredPaths.has(path) ||
            !["100644", "100755"].includes(oldMode)
          )
            continue;
          const expected = `${oldMode} blob ${oldBlob}`;
          if (
            entryAt(sourceParent, sourcePath) !== expected ||
            entryAt(automaticTree, path) !== expected ||
            entryAt(resolvedTree, path) !== expected ||
            entryAt(evidence.pull.head.sha, path) !== expected
          )
            continue;
          const sourceCommitShas = evidence.commitAttribution
            .filter(
              (entry) =>
                /^[a-f0-9]{40}$/u.test(entry.sha) &&
                entry.limitations.length === 0 &&
                entry.changedPaths?.includes(sourcePath) &&
                git("merge-base", "--is-ancestor", entry.sha, sourceParent)
                  .status === 0,
            )
            .map((entry) => entry.sha)
            .sort();
          if (!sourceCommitShas.length) continue;
          automaticRelocations.push({
            sourceParent,
            sourcePath,
            path,
            blobSha: oldBlob,
            headSha: evidence.pull.head.sha,
            sourceCommitShas,
          });
        }
      }
      resolutions.push({
        commitSha: commit.sha,
        parents,
        gitVersion,
        automaticTree,
        resolvedTree,
        hadConflicts: merged.status === 1,
        patch,
        patchSha256: createHash("sha256").update(patch).digest("hex"),
        paths,
        ...(automaticRelocations.length ? { automaticRelocations } : {}),
      });
    }
    return { ...evidence, mergeResolutions: resolutions };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
