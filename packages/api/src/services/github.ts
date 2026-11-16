import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import { AuthError } from "../auth/store";
import { object, type ServiceSource } from "./spec";

const issuer = "https://token.actions.githubusercontent.com";
const keys = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks`), {
  timeoutDuration: 5000,
  cooldownDuration: 30000,
});
export async function githubSource(value: unknown): Promise<ServiceSource> {
  const v = object(value);
  if (v.type === "image") return { type: "image" };
  if (
    v.type !== "github" ||
    typeof v.repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v.repository) ||
    v.repository.length > 200 ||
    typeof v.branch !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_./-]{0,99}$/.test(v.branch) ||
    v.branch.includes("..")
  )
    throw new AuthError("INVALID_REPOSITORY");
  const dockerfile = String(v.dockerfile ?? "Dockerfile"),
    context = String(v.context ?? ".");
  for (const path of [dockerfile, context])
    if (
      !/^(\.|[A-Za-z0-9_][A-Za-z0-9_./-]{0,149})$/.test(path) ||
      path.split("/").includes("..")
    )
      throw new AuthError("INVALID_BUILD_PATH");
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "Ephor",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (
    typeof v.readToken === "string" &&
    v.readToken.length <= 1000 &&
    v.readToken
  )
    headers.Authorization = `Bearer ${v.readToken}`;
  const response = await fetch(`https://api.github.com/repos/${v.repository}`, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new AuthError("GITHUB_REPOSITORY_UNAVAILABLE", 400);
  const repo = (await response.json()) as {
    id: number;
    full_name: string;
    owner: { id: number };
  };
  if (!Number.isSafeInteger(repo.id) || !Number.isSafeInteger(repo.owner?.id))
    throw new AuthError("GITHUB_REPOSITORY_UNAVAILABLE");
  // Numeric identities prevent deleted/renamed repository takeover. The read token is discarded.
  return {
    type: "github",
    repository: repo.full_name,
    repositoryId: String(repo.id),
    ownerId: String(repo.owner.id),
    branch: v.branch,
    dockerfile,
    context,
  };
}
export async function githubIdentity(
  token: string,
  id: string,
  source: ServiceSource,
  verifier: JWTVerifyGetKey = keys,
) {
  if (token.length > 12000)
    throw new AuthError("INVALID_DEPLOYMENT_IDENTITY", 401);
  try {
    const { payload } = await jwtVerify(token, verifier, {
      issuer,
      audience: `ephor:${id}`,
      algorithms: ["RS256"],
      maxTokenAge: "10m",
      clockTolerance: 5,
    });
    if (
      source.type !== "github" ||
      payload.repository_id !== source.repositoryId ||
      payload.repository_owner_id !== source.ownerId ||
      payload.repository !== source.repository ||
      payload.ref !== `refs/heads/${source.branch}` ||
      payload.workflow_ref !==
        `${source.repository}/.github/workflows/ephor-${id}.yml@refs/heads/${source.branch}` ||
      !["push", "workflow_dispatch"].includes(String(payload.event_name)) ||
      payload.runner_environment !== "github-hosted" ||
      !/^[a-f0-9]{40}$/.test(String(payload.sha)) ||
      !/^\d{1,15}$/.test(String(payload.run_id)) ||
      !/^\d{1,10}$/.test(String(payload.run_number))
    )
      throw new Error("Claims rejected");
    return {
      sha: String(payload.sha),
      run: Number(payload.run_number),
      delivery: `github:${id}:${payload.run_id}`,
    };
  } catch {
    throw new AuthError("INVALID_DEPLOYMENT_IDENTITY", 401);
  }
}
export function workflow(id: string, source: ServiceSource, origin: string) {
  // All dynamic values are validated and emitted as YAML quoted scalars, never shell source.
  return `name: Deploy to Ephor
on:
  push:
    branches: [${JSON.stringify(source.branch)}]
  workflow_dispatch:
permissions:
  contents: read
concurrency:
  group: ephor-${id}
  cancel-in-progress: false
jobs:
  build:
    runs-on: ${source.architecture === "aarch64" ? "ubuntu-24.04-arm" : "ubuntu-24.04"}
    timeout-minutes: 30
    permissions:
      contents: read
      packages: write
    outputs:
      image: \${{ steps.build.outputs.image }}
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
        with:
          persist-credentials: false
      - name: Build and publish
        id: build
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          DOCKERFILE: ${JSON.stringify(source.dockerfile)}
          CONTEXT: ${JSON.stringify(source.context)}
        run: |
          set -euo pipefail
          image="ghcr.io/\${GITHUB_REPOSITORY,,}/ephor-${id}"
          echo "$GH_TOKEN" | docker login ghcr.io -u "$GITHUB_ACTOR" --password-stdin
          docker buildx build --file "$DOCKERFILE" --tag "$image:$GITHUB_SHA" --tag "$image:latest" --push --metadata-file /tmp/metadata.json "$CONTEXT"
          digest=$(jq -er '."containerimage.digest"' /tmp/metadata.json)
          echo "image=$image@$digest" >> "$GITHUB_OUTPUT"
      - name: Remove registry credentials
        if: always()
        run: docker logout ghcr.io
  deploy:
    needs: build
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions:
      id-token: write
    steps:
      - name: Request deployment
        env:
          EPHOR_ORIGIN: ${JSON.stringify(origin)}
          IMAGE: \${{ needs.build.outputs.image }}
        run: |
          set -euo pipefail
          jq -n --arg image "$IMAGE" '{image:$image}' > /tmp/deploy.json
          accepted=false
          for attempt in $(seq 1 60); do
            token=$(curl --fail --silent --show-error -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=ephor%3A${id}" | jq -er .value)
            echo "::add-mask::$token"
            if [ "$accepted" = false ]; then
              code=$(curl --silent --show-error --max-time 20 -o /tmp/result.json -w '%{http_code}' -H "Authorization: Bearer $token" -H 'Content-Type: application/json' --data-binary @/tmp/deploy.json "$EPHOR_ORIGIN/api/deploy/github/${id}")
              case "$code" in
                200) accepted=true ;;
                409|429|500|502|503|504) sleep 15; continue ;;
                *) cat /tmp/result.json; exit 1 ;;
              esac
            fi
            code=$(curl --silent --show-error --max-time 20 -o /tmp/result.json -w '%{http_code}' -H "Authorization: Bearer $token" -H 'Content-Type: application/json' --data '{}' "$EPHOR_ORIGIN/api/deploy/github/${id}/status")
            if [ "$code" = 200 ]; then
              status=$(jq -er .status /tmp/result.json)
              case "$status" in
                succeeded) echo 'Deployment healthy and live.'; exit 0 ;;
                failed|cancelled|expired) cat /tmp/result.json; exit 1 ;;
              esac
            fi
            sleep 15
          done
          echo 'Deployment confirmation timed out. Check its status in Ephor; an accepted deployment may still complete.' >&2
          exit 1
`;
}
