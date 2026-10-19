/**
 * Reads the live pin a vetting clearance must match (PRD VET-07): the head
 * commit of the project's integration branch on GitHub and the commit of the
 * deployed skill template. Every failure throws, so a caller never compares
 * a clearance with a guessed commit.
 */

import type { ProjectDefinition } from "../../src/lib/projects.mjs";
import { type GithubFetch, readBranchHead } from "../projects/github-lookup";
import type { VettingPin } from "./persistence";

export type VettingGithub = {
  fetch: GithubFetch;
  token?: string;
  apiOrigin: string;
};

export async function readVettingPin(
  github: VettingGithub,
  manifest: ProjectDefinition,
  templateCommit: string,
): Promise<VettingPin> {
  if (!/^[0-9a-f]{40}$/u.test(templateCommit))
    throw new Error("The skill template commit is not a full SHA.");
  const repository = manifest.repositories[0];
  if (repository === undefined)
    throw new Error("The manifest names no repository.");
  return {
    commitSha: await readBranchHead(
      github.fetch,
      github.token,
      repository.id,
      repository.integrationBranch,
      github.apiOrigin,
    ),
    templateCommit,
  };
}
