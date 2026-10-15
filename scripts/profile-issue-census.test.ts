import { afterEach, expect, it, mock } from "bun:test";
import {
  assertProfiles,
  type ProfileIndex,
  type ProfileIssue,
  type ProfileRecord,
} from "../src/lib/profiles";
import * as repositories from "../src/lib/repositories.mjs";
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
const pausedRepository = REGISTERED_REPOSITORIES.find(
  (repository) => !TARGET_REPOSITORIES.some(({ id }) => id === repository.id),
);
const paused = pausedRepository?.id as string;
const registry = { ...repositories };
afterEach(() => {
  mock.module("../src/lib/repositories.mjs", () => registry);
});

/** Collect the paused repository again, as after its project is reactivated. */
function reactivate() {
  mock.module("../src/lib/repositories.mjs", () => ({
    ...registry,
    TARGET_REPOSITORIES: [...registry.TARGET_REPOSITORIES, pausedRepository],
  }));
}
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
        count: items.filter(
          (item) =>
            item.repository === repository && item.unavailableSince === null,
        ).length,
      })),
      items,
    },
  };
}

/** GitHub returns only `live`; other prior issues were deleted. */
function github(live: ProfileIssue[] = []): CensusRequest {
  return async <T>(
    _query: string,
    { owner, name }: Record<string, string | null>,
  ): Promise<T> => {
    const repository = TARGET_REPOSITORIES.find(
      (target) => target.owner === owner && target.name === name,
    );
    const nodes = live
      .filter((record) => record.repository === repository?.id)
      .map((record) => ({
        id: record.id,
        number: record.number,
        createdAt: record.createdAt,
        state: record.state,
        stateReason: record.reason,
        author: { __typename: "User", ...author },
        timelineItems: {
          totalCount: record.events.length,
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: record.events.map((event) => ({
            __typename: "ClosedEvent",
            id: event.id,
            createdAt: event.occurredAt,
            stateReason: event.reason,
            duplicateOf: null,
          })),
        },
      }));
    return {
      repository: {
        id: repository?.expectedNodeId ?? `R_${name}`,
        issues: {
          totalCount: nodes.length,
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes,
        },
      },
    } as T;
  };
}

/** The `generate-profiles --live` sequence after the PR census. */
async function regenerate(previous: ProfileIndex, request = github()) {
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
  const index = {
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
  } satisfies ProfileIndex;
  assertProfiles(index);
  return index;
}

it("keeps an unavailable issue of an active project as a coverage gap", async () => {
  const { issues } = await regenerate(
    previousCensus([issue("I_active", active)]),
  );
  expect(issues.items.map(({ id }) => id)).toEqual(["I_active"]);
  expect(issues.items[0].unavailableSince).not.toBeNull();
});

it("keeps a paused project's issues out of the active census", async () => {
  expect(paused).toBeString();
  const { issues } = await regenerate(
    previousCensus([issue("I_active", active), issue("I_paused", paused)]),
  );
  expect(issues.items.map(({ id }) => id)).toEqual(["I_active"]);
  expect(issues.repositories.map(({ repository }) => repository)).toEqual(
    TARGET_REPOSITORIES.map(({ id }) => id),
  );
});

it("resumes a paused project's issue history when it is reactivated", async () => {
  const corrected = {
    ...issue("I_corrected", paused),
    correctedAt: "2026-10-10T00:05:00.000Z",
  };
  const incomplete = {
    ...issue("I_incomplete", paused),
    events: [],
    historyIncompleteSince: "2026-10-10T00:05:00.000Z",
  };
  const unavailable = {
    ...issue("I_unavailable", paused),
    unavailableSince: "2026-10-10T00:05:00.000Z",
  };
  // Still on GitHub when the project is paused, deleted before reactivation.
  const deleted = issue("I_deleted", paused);
  const pausedCensus = await regenerate(
    previousCensus([corrected, incomplete, unavailable, deleted]),
  );
  expect(pausedCensus.issues.items).toEqual([]);

  reactivate();
  const { issues } = await regenerate(
    pausedCensus,
    github([corrected, incomplete]),
  );
  const markers = Object.fromEntries(
    issues.items.map((item) => [
      item.id,
      {
        unavailable: item.unavailableSince !== null,
        correctedAt: item.correctedAt,
        historyIncompleteSince: item.historyIncompleteSince,
      },
    ]),
  );
  expect(markers).toEqual({
    I_corrected: {
      unavailable: false,
      correctedAt: corrected.correctedAt,
      historyIncompleteSince: null,
    },
    I_incomplete: {
      unavailable: false,
      correctedAt: null,
      historyIncompleteSince: incomplete.historyIncompleteSince,
    },
    I_unavailable: {
      unavailable: true,
      correctedAt: null,
      historyIncompleteSince: null,
    },
    I_deleted: {
      unavailable: true,
      correctedAt: null,
      historyIncompleteSince: null,
    },
  });
  expect(
    issues.items.find(({ id }) => id === "I_unavailable")?.unavailableSince,
  ).toBe(unavailable.unavailableSince);
});

it("archives a paused project's records unchanged and validates them", async () => {
  const census = await regenerate(previousCensus([issue("I_paused", paused)]));
  expect(census.issues.archived).toEqual([issue("I_paused", paused)]);
  for (const repository of [active, "example/unregistered"]) {
    const archived = [{ ...issue("I_paused", paused), repository }];
    expect(() =>
      assertProfiles({ ...census, issues: { ...census.issues, archived } }),
    ).toThrow("Invalid issue history record");
  }
});
