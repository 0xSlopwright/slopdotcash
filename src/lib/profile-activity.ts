import type { ScoreEvent } from "./leaderboard";
import { findIngestedProjectByRepositoryId } from "./projects.mjs";

/**
 * Slop Score per UTC day for the `days` days that end on `today`. An event
 * counts from its project's reward start, as in the cumulative Slop Score
 * (createGlobalLeaders) and the project cycle window.
 */
export function dailySlopScore(
  work: readonly ScoreEvent[],
  today: Date,
  days: number,
): Array<{ day: string; score: number }> {
  const entries = Array.from({ length: days }, (_, index) => ({
    day: new Date(
      Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate() - (days - 1 - index),
      ),
    )
      .toISOString()
      .slice(0, 10),
    score: 0,
  }));
  const byDay = new Map(entries.map((entry) => [entry.day, entry]));
  for (const event of work) {
    const entry = byDay.get(event.occurredAt.slice(0, 10));
    if (!entry) continue;
    const project = findIngestedProjectByRepositoryId(event.repository);
    if (!project)
      throw new TypeError(`Score event ${event.id} has no registered project`);
    if (Date.parse(event.occurredAt) < Date.parse(project.reward.rewardStartAt))
      continue;
    entry.score += event.points;
  }
  return entries;
}
