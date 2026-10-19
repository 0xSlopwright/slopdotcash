/**
 * Run only while holding the workflow's slop-staging concurrency lock.
 * Cost: one development fetch and up to ten 100-record GitHub history reads.
 * Failed attempts count: they may have already changed a Worker or database.
 */
import { execFileSync } from "node:child_process";

const revision = process.env.GITHUB_SHA;
if (
  process.env.GITHUB_REPOSITORY !== "SlopDotCash/slopdotcash" ||
  process.env.GITHUB_REF !== "refs/heads/development" ||
  !/^[a-f0-9]{40}$/.test(revision ?? "")
) {
  throw new Error("Staging order requires a canonical development revision");
}
const options = {
  encoding: "utf8",
  timeout: 30000,
  maxBuffer: 2 * 1024 * 1024,
};
if (execFileSync("git", ["rev-parse", "HEAD"], options).trim() !== revision) {
  throw new Error("Staging checkout does not match the checked revision");
}
// A newer branch tip does not invalidate a fully checked ancestor. A force-push
// that removes it does. Fetch before comparing; checkout-time refs may be stale.
execFileSync(
  "git",
  ["fetch", "--no-tags", "origin", "refs/heads/development"],
  options,
);
const tip = execFileSync("git", ["rev-parse", "FETCH_HEAD"], options).trim();
execFileSync("git", ["merge-base", "--is-ancestor", revision, tip], options);

const checked = new Set();
for (let page = 1; page <= 10; page++) {
  const history = JSON.parse(
    execFileSync(
      "gh",
      [
        "api",
        `repos/SlopDotCash/slopdotcash/deployments?environment=slop-staging&per_page=100&page=${page}`,
      ],
      options,
    ),
  );
  if (!Array.isArray(history) || history.length > 100) {
    throw new Error("Invalid staging deployment history");
  }
  for (const deployment of history) {
    if (
      deployment?.environment !== "slop-staging" ||
      deployment.ref !== "development" ||
      deployment.production_environment !== false ||
      !/^[a-f0-9]{40}$/.test(deployment.sha ?? "")
    ) {
      throw new Error(
        "Unknown staging deployment provenance; require human review",
      );
    }
    if (checked.has(deployment.sha)) continue;
    checked.add(deployment.sha);
    // Do not inspect only successful Pages releases: a failed newer attempt may
    // have applied migrations or published identity before the Pages failure.
    try {
      execFileSync(
        "git",
        ["merge-base", "--is-ancestor", deployment.sha, revision],
        options,
      );
    } catch (cause) {
      throw new Error(
        `Refusing staging rollback across attempted revision ${deployment.sha}`,
        { cause },
      );
    }
  }
  if (history.length < 100) {
    if (!checked.has(revision)) {
      throw new Error(
        "Current staging attempt is absent from deployment history",
      );
    }
    console.log(`Staging order verified for ${revision}`);
    process.exit(0);
  }
}
throw new Error("Staging history exceeds its bound; require human review");
