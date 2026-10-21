/**
 * Exports the tracked tree into a scratch directory and restores the frozen
 * pre-registry projects and history from tests/fixtures. Scripts that read
 * fixed repository paths, such as the cycle index sync, run inside it.
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");

export function fixtureCheckout(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const archive = spawnSync("git", ["archive", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (archive.status !== 0) throw new Error("git archive failed");
  const extract = spawnSync("tar", ["-x", "-f", "-", "-C", root], {
    input: archive.stdout,
  });
  if (extract.status !== 0) throw new Error("tar extract failed");
  copyFileSync(
    join(repositoryRoot, "tests/fixtures/project-registry.mjs"),
    join(root, "src/lib/project-registry.generated.mjs"),
  );
  cpSync(join(repositoryRoot, "tests/fixtures/history"), root, {
    recursive: true,
  });
  symlinkSync(
    join(repositoryRoot, "node_modules"),
    join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  mkdirSync(join(root, ".bun-tmp"), { recursive: true });
  return root;
}
