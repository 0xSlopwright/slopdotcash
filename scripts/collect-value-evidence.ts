/** Read-only evidence export. Raw source evidence stays outside the repository. */
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { assertProjectRegistry } from "../src/lib/project-schema.mjs";
import { collectTargetRepositories } from "../src/lib/repositories.mjs";
import {
  collectValueContext,
  type ValueContextSelection,
} from "../workers/slopbot/value-context";
import {
  collectValueEvidence,
  type EvidenceClient,
} from "../workers/slopbot/value-evidence";
import {
  fetchProjectRegistry,
  renderProjectRevisions,
} from "./sync-project-registry.mjs";

const [repository, numberText, directory, ...contextArgs] =
  process.argv.slice(2);
if (!repository || !numberText || !directory)
  throw new Error(
    "Usage: bun scripts/collect-value-evidence.ts owner/repo PR_NUMBER /absolute/private-output-directory [context-path | --context-at SHA path ...]",
  );
const contextPaths: ValueContextSelection[] = [];
for (let index = 0; index < contextArgs.length; index += 1) {
  if (contextArgs[index] !== "--context-at") {
    contextPaths.push(contextArgs[index]);
    continue;
  }
  const ref = contextArgs[++index];
  const path = contextArgs[++index];
  if (!ref || !/^[a-f0-9]{40}$/u.test(ref) || !path)
    throw new Error(
      "--context-at requires an immutable SHA and repository path",
    );
  contextPaths.push({ path, ref });
}
const output = resolve(directory);
if (!isAbsolute(directory))
  throw new Error("Output directory must be absolute");
const repositoryRoot = await realpath(resolve(import.meta.dir, ".."));
if (output === repositoryRoot || output.startsWith(`${repositoryRoot}/`))
  throw new Error("Raw evidence must be outside the repository");
await mkdir(output, { recursive: true, mode: 0o700 });
const canonicalOutput = await realpath(output);
if (
  canonicalOutput === repositoryRoot ||
  canonicalOutput.startsWith(`${repositoryRoot}/`)
)
  throw new Error(
    "Raw evidence must be outside the repository, including through symlinks",
  );
const client: EvidenceClient = {
  async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const result = Bun.spawn(["gh", "api", "graphql", "--input", "-"], {
      stdin: new Blob([JSON.stringify({ query, variables })]),
      stdout: "pipe",
      stderr: "ignore",
    });
    const [body, status] = await Promise.all([
      new Response(result.stdout).text(),
      result.exited,
    ]);
    if (status !== 0) throw new Error("GitHub author evidence request failed");
    const response = JSON.parse(body) as { data?: T; errors?: unknown[] };
    if (!response.data || response.errors?.length)
      throw new Error("GitHub author evidence incomplete");
    return response.data;
  },
  async get<T>(path: string): Promise<T | null> {
    const result = Bun.spawn(["gh", "api", path], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const [body, status] = await Promise.all([
      new Response(result.stdout).text(),
      result.exited,
    ]);
    if (status !== 0)
      throw new Error(`GitHub evidence request failed: ${path}`);
    return JSON.parse(body) as T;
  },
};
const registry = await fetchProjectRegistry();
const projects = assertProjectRegistry(registry.projects);
renderProjectRevisions(registry.revisions, projects);
const repositoryPolicy = collectTargetRepositories(projects).find((entry) =>
  [entry.id, ...entry.aliases].some(
    (id) => id.toLowerCase() === repository.toLowerCase(),
  ),
);
if (!repositoryPolicy)
  throw new Error("Repository is not active in the live project registry");
const collected = await collectValueEvidence(
  client,
  repository,
  Number(numberText),
  repositoryPolicy,
);
const evidence = await collectValueContext(client, collected, contextPaths);
const bytes = `${JSON.stringify(evidence, null, 2)}\n`;
const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const path = `${canonicalOutput}/${repository.replace("/", "-")}-${numberText}-${digest}.json`;
await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
console.log(
  JSON.stringify({
    path,
    sha256: digest,
    complete: evidence.limitations.length === 0,
    limitations: evidence.limitations,
    files: evidence.files.length,
    reviews: evidence.reviews.length,
    comments: evidence.comments.length + evidence.reviewComments.length,
  }),
);
