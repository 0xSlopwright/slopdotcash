import { readBoundedJson } from "../browser-json";
import type { EscrowIdentity } from "./escrow-cycle";

export async function resolveEscrowIdentities(
  nodeIds: string[],
  token: string,
): Promise<EscrowIdentity[]> {
  const authorization = token;
  if (!authorization)
    throw new Error("GitHub identity verification is unavailable");
  const result: EscrowIdentity[] = [];
  for (let i = 0; i < nodeIds.length; i += 100) {
    const ids = nodeIds.slice(i, i + 100);
    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        authorization: `Bearer ${authorization}`,
        "content-type": "application/json",
        "user-agent": "Slop-award-review",
      },
      body: JSON.stringify({
        query:
          "query($ids:[ID!]!){nodes(ids:$ids){... on User{id databaseId login}}}",
        variables: { ids },
      }),
    });
    if (!response.ok) throw new Error("GitHub numeric identity lookup failed");
    const body = (await readBoundedJson(
      response,
      1048576,
      "GitHub actor identities",
    )) as {
      errors?: unknown;
      data?: { nodes?: { id: string; databaseId: number; login: string }[] };
    };
    if (body.errors || body.data?.nodes?.length !== ids.length)
      throw new Error("Incomplete GitHub identity evidence");
    for (const [index, node] of body.data.nodes.entries()) {
      if (
        !node ||
        node.id !== ids[index] ||
        !Number.isSafeInteger(node.databaseId) ||
        node.databaseId <= 0 ||
        typeof node.login !== "string"
      )
        throw new Error("GitHub actor identity mismatch");
      result.push({
        nodeId: node.id,
        githubUserId: String(node.databaseId),
        login: node.login,
      });
    }
  }
  return result.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
}
