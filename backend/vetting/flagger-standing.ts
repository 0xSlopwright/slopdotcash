/**
 * Who may file a contributor flag (owner decision D3, issue #911).
 *
 * A flagger is a signed-in member whose GitHub account is at least 30 days
 * old and who has at least one accepted contribution: a merged pull request
 * in a registered Slop project repository, counted by the published profile
 * census under the member's immutable GitHub node ID. The project's own
 * maintainers cannot flag it. GitHub marks them as owner, member or
 * collaborator of a project repository, or lists them as a public member of
 * the organization that owns it. Every fact comes from GitHub or the census
 * at filing time. A failed read refuses the flag; it never admits one.
 */

import { readBoundedJson } from "../../src/lib/browser-json";
import { assertProfiles } from "../../src/lib/profiles";
import type { GithubActor, ProjectRecord } from "../projects/contracts";
import {
  type GithubFetch,
  GithubLookupError,
  githubJson,
  requestInit,
  validGithubLogin,
} from "../projects/github-lookup";

export type FlaggerStanding = {
  accountCreatedAt: string;
  acceptedContributions: number;
  maintainer: boolean;
};

export type FlaggerStandingReader = (
  actor: GithubActor,
  project: ProjectRecord,
) => Promise<FlaggerStanding>;

const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const REPOSITORY = /^([A-Za-z0-9_.-]+)\/[A-Za-z0-9_.-]+$/u;
const MAX_PROFILE_BYTES = 8 * 1024 * 1024;

function incomplete(): never {
  throw new GithubLookupError(
    502,
    "github_unavailable",
    "GitHub returned incomplete account facts.",
  );
}

export function githubFlaggerStanding(input: {
  fetch: GithubFetch;
  token?: string;
  apiOrigin: string;
  /** Reads the published profile census (`/data/profiles.json`). */
  readProfiles: () => Promise<Response>;
}): FlaggerStandingReader {
  return async (actor, project) => {
    // The immutable account id names the current login and node id.
    const user = await githubJson(
      input.fetch,
      input.token,
      `/user/${actor.githubId}`,
      input.apiOrigin,
    );
    if (
      user === null ||
      user.type !== "User" ||
      String(user.id) !== actor.githubId ||
      typeof user.login !== "string" ||
      !validGithubLogin(user.login) ||
      typeof user.node_id !== "string" ||
      typeof user.created_at !== "string" ||
      !Number.isFinite(Date.parse(user.created_at))
    )
      incomplete();
    const login = user.login;
    const nodeId = user.node_id;

    let maintainer = false;
    const owners = new Set<string>();
    for (const { id } of project.manifest.repositories) {
      const owner = REPOSITORY.exec(id)?.[1];
      if (owner === undefined) incomplete();
      owners.add(owner);
      const response = await input.fetch(
        `${input.apiOrigin}/repos/${id}/issues?creator=${encodeURIComponent(login)}&state=all&per_page=1`,
        requestInit(input.token),
      );
      // A renamed or removed repository has no association to read.
      if (response.status === 404) continue;
      if (!response.ok)
        throw new GithubLookupError(
          502,
          "github_unavailable",
          `GitHub returned ${response.status}.`,
        );
      const items = await readBoundedJson(
        response,
        512 * 1024,
        "GitHub issues",
      );
      if (!Array.isArray(items)) incomplete();
      if (
        items.some((item) =>
          MAINTAINER_ASSOCIATIONS.has(
            (item as { author_association?: unknown })
              .author_association as string,
          ),
        )
      )
        maintainer = true;
    }
    for (const owner of owners) {
      if (maintainer) break;
      const response = await input.fetch(
        `${input.apiOrigin}/orgs/${owner}/public_members/${encodeURIComponent(login)}`,
        requestInit(input.token),
      );
      if (response.status === 204) maintainer = true;
      else if (response.status !== 404)
        throw new GithubLookupError(
          502,
          "github_unavailable",
          `GitHub returned ${response.status}.`,
        );
    }

    const profiles = await input.readProfiles();
    if (!profiles.ok) throw new Error("The profile census is unavailable");
    const index = await readBoundedJson(
      profiles,
      MAX_PROFILE_BYTES,
      "profile census",
    );
    assertProfiles(index);
    const person = index.people.find((entry) => entry.id === nodeId);
    const acceptedContributions =
      person?.repositories.reduce((sum, entry) => sum + entry.merged, 0) ?? 0;

    return {
      accountCreatedAt: new Date(user.created_at).toISOString(),
      acceptedContributions,
      maintainer,
    };
  };
}
