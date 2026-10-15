import { expect, it } from "bun:test";
import {
  assertProfiles,
  type ProfileIndex,
  type ProfileIssue,
  type ProfileRecord,
} from "../src/lib/profiles";
import {
  REGISTERED_REPOSITORIES,
  TARGET_REPOSITORIES,
} from "../src/lib/repositories.mjs";
import {
  type CensusRequest,
  collectProfileIssues,
} from "./profile-issue-census";

const active = TARGET_REPOSITORIES[0].id;
// A registered project that is not collected now, as after a pause.
const paused = REGISTERED_REPOSITORIES.find(
  (repository) => !TARGET_REPOSITORIES.some(({ id }) => id === repository.id),
)?.id as string;
const author: ProfileRecord = {
  id: "U_kgDOBnUs3Q",
  login: "alice",
  avatarUrl: "https://avatars.githubusercontent.com/u/108342493?v=4",
  repositories: [],
};

function issue(id: string, repository: string): ProfileIssue {
  return {
    id,
    repository,
    number: 7,
    authorId: author.id,
    createdAt: "2026-10-09T10:00:00Z",
    observedAt: "2026-10-10T00:05:00.000Z",
    state: "CLOSED",
    reason: "COMPLETED",
    unavailableSince: null,
    correctedAt: null,
    historyIncompleteSince: null,
    events: [
      {
        id: `CE_${id}`,
        kind: "closed",
        occurredAt: "2026-10-09T11:00:00Z",
        reason: "COMPLETED",
        relatedIssueId: null,
      },
    ],
  };
}

/** A census published while `paused` was still active. */
function previousCensus(items: ProfileIssue[]): ProfileIndex {
  const inventory = [...TARGET_REPOSITORIES.map(({ id }) => id), paused];
  return {
    schemaVersion: "2",
    startedAt: "2026-10-10T00:00:00.000Z",
    generatedAt: "2026-10-10T00:10:00.000Z",
    repositories: inventory.map((repository) => ({
      repository,
      count: 0,
      excluded: 0,
    })),
    people: [author],
    issues: {
      firstObservedAt: "2026-10-10T00:00:00.000Z",
      repositories: inventory.map((repository) => ({
        repository,
        count: items.filter((item) => item.repository === repository).length,
      })),
      items,
    },
  };
}

// GitHub no longer returns the prior issues, e.g. they were deleted.
const request: CensusRequest = async <T>(
  _query: string,
  { owner, name }: Record<string, string | null>,
): Promise<T> =>
  ({
    repository: {
      id:
        TARGET_REPOSITORIES.find(
          (repository) =>
            repository.owner === owner && repository.name === name,
        )?.expectedNodeId ?? `R_${name}`,
      issues: {
        totalCount: 0,
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [],
      },
    },
  }) as T;

/** The `generate-profiles --live` sequence after the PR census. */
async function regenerate(previous: ProfileIndex) {
  assertProfiles(
    previous,
    previous.repositories.map(({ repository }) => repository),
  );
  const people = new Map<string, ProfileRecord>();
  const startedAt = new Date().toISOString();
  const issues = await collectProfileIssues(
    request,
    people,
    previous,
    startedAt,
  );
  const index: ProfileIndex = {
    schemaVersion: "2",
    startedAt,
    generatedAt: new Date().toISOString(),
    repositories: TARGET_REPOSITORIES.map(({ id }) => ({
      repository: id,
      count: 0,
      excluded: 0,
    })),
    people: [...people.values()],
    issues,
  };
  assertProfiles(index);
  return issues;
}

it("keeps an unavailable issue of an active project as a coverage gap", async () => {
  const issues = await regenerate(previousCensus([issue("I_active", active)]));
  expect(issues.items.map(({ id }) => id)).toEqual(["I_active"]);
  expect(issues.items[0].unavailableSince).not.toBeNull();
});

it("drops the issue history of a project paused after the previous census", async () => {
  expect(paused).toBeString();
  const issues = await regenerate(
    previousCensus([issue("I_active", active), issue("I_paused", paused)]),
  );
  expect(issues.items.map(({ id }) => id)).toEqual(["I_active"]);
  expect(issues.repositories.map(({ repository }) => repository)).toEqual(
    TARGET_REPOSITORIES.map(({ id }) => id),
  );
});
