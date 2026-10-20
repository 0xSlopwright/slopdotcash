/**
 * A loopback stand-in for the public GitHub API reads the project registry
 * makes (repository facts, organization membership, the integration-branch
 * head that security vetting pins, and the security intake readiness check),
 * so the registry browser lane is deterministic and never
 * spends GitHub's rate limit. The browser's own repository lookup is mocked
 * from the same facts.
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";

/** The site session that owns its user repositories. */
export const E2E_OWNER = { githubId: "900000003", login: "e2e-owner" };
/** An organization whose members are never public. */
export const E2E_ORGANIZATION = { githubId: "987654320", login: "example" };

/** Site sessions for the private security bounty roles, by role name. */
export const E2E_SECURITY_ACCOUNTS = Object.freeze({
  "reporter-a": "900000011",
  "reporter-b": "900000012",
  security: "900000013",
  triager: "900000014",
  finance: "900000015",
  dispute: "900000016",
  "security-b": "900000017",
});

/** Deterministic public facts for a fixture repository. */
export function fixtureRepository(fullName) {
  const [ownerLogin, name] = fullName.split("/");
  const owner =
    ownerLogin === E2E_OWNER.login
      ? { login: E2E_OWNER.login, id: Number(E2E_OWNER.githubId), type: "User" }
      : {
          login: E2E_ORGANIZATION.login,
          id: Number(E2E_ORGANIZATION.githubId),
          type: "Organization",
        };
  let hash = 0;
  for (const character of fullName)
    hash = (hash * 31 + character.charCodeAt(0)) % 100_000;
  return {
    id: 123_400_000 + hash,
    node_id: `R_${fullName.replaceAll(/[^A-Za-z0-9]/gu, "_")}`,
    full_name: `${owner.login}/${name}`,
    description: "A reproducible research tool used by the registry tests.",
    private: false,
    default_branch: "main",
    owner: { ...owner, node_id: `O_${owner.login.replaceAll("-", "_")}` },
  };
}

/** The deterministic head commit of a fixture repository branch. */
export function fixtureBranchHead(fullName, branch) {
  return createHash("sha1").update(`${fullName}#${branch}`).digest("hex");
}

export function startGitHubApiFixture(port) {
  // Private vulnerability reporting per repository; on unless a test sets it.
  const intake = new Map();
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const control =
      /^\/__fixture\/private-vulnerability-reporting\/([^/]+\/[^/]+)\/(enabled|disabled|forbidden|unavailable)$/u.exec(
        path,
      );
    if (request.method === "PUT" && control) {
      intake.set(control[1].toLowerCase(), control[2]);
      response.writeHead(204);
      response.end();
      return;
    }
    const reporting =
      /^\/repos\/([^/]+\/[^/]+)\/private-vulnerability-reporting$/u.exec(path);
    if (request.method === "GET" && reporting) {
      const state = intake.get(reporting[1].toLowerCase()) ?? "enabled";
      if (state === "forbidden" || state === "unavailable") {
        response.writeHead(state === "forbidden" ? 403 : 503, {
          "content-type": "application/json",
        });
        response.end('{"message":"Fixture refusal"}');
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ enabled: state === "enabled" }));
      return;
    }
    const repository = /^\/repos\/([^/]+\/[^/]+)$/u.exec(path);
    const branch = /^\/repos\/([^/]+\/[^/]+)\/branches\/([^/]+)$/u.exec(path);
    // A stable integration-branch head, which security vetting pins.
    if (request.method === "GET" && branch) {
      const name = decodeURIComponent(branch[2]);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          name,
          commit: { sha: fixtureBranchHead(branch[1], name) },
        }),
      );
      return;
    }
    if (request.method === "GET" && repository) {
      const [owner] = repository[1].split("/");
      if (owner === E2E_OWNER.login || owner === E2E_ORGANIZATION.login) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(fixtureRepository(repository[1])));
        return;
      }
    }
    // Organization membership is private, so it is never proven.
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"message":"Not Found"}');
  });
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () => resolve(server)),
  );
}
