import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { PanelUpdates } from "../src/panel/updates";
import { GitHubApp } from "../src/services/github-app";
import { enrolled, fixture, timestamp } from "./helpers";

const base = "a".repeat(40),
  target = "b".repeat(40),
  head = "c".repeat(40),
  merged = "d".repeat(40),
  previous = "e".repeat(40);
const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const encoded = (value: unknown) => ({
  encoding: "base64",
  content: btoa(typeof value === "string" ? value : JSON.stringify(value)),
});
async function setup(deployment = "git", host = "cloudflare") {
  const f = await fixture();
  const calls: {
    path: string;
    method: string;
    body: Record<string, unknown> | undefined;
  }[] = [];
  const remote = {
    branch: base,
    prepared: head,
    version: previous,
    run: "success",
    ci: "success",
    check: "success",
    mergeable: true,
    mergeableState: "clean",
    merged: false,
    identity: 123,
    defaultBranch: "main",
    protocol: true,
    dispatched: 0,
    pr: false,
    prHead: head,
    parent: base,
    files: [
      {
        filename: "packages/api/migrations/sqlite/0026_example.sql",
        status: "added",
        additions: 3,
        deletions: 0,
        patch: "+CREATE TABLE example(id TEXT);",
      },
    ],
  };
  let panel: PanelUpdates;
  const pull = () => ({
    number: 7,
    state: remote.merged ? "closed" : "open",
    merged: remote.merged,
    merge_commit_sha: remote.merged ? merged : null,
    head: {
      sha: remote.prHead,
      ref: `ephor-update/${target}`,
      repo: { id: 123 },
    },
    base: { sha: remote.branch, ref: "main", repo: { id: 123 } },
    mergeable: remote.mergeable,
    mergeable_state: remote.mergeableState,
  });
  const request = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)),
      path = url.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({
      path: path + url.search,
      method: init?.method ?? "GET",
      body,
    });
    const local = "/repos/acme/panel";
    if (path === "/app/installations/99/access_tokens")
      return Response.json({ token: "scoped-token" });
    if (path === "/repositories/123")
      return Response.json({
        id: remote.identity,
        full_name: "acme/panel",
        default_branch: remote.defaultBranch,
        archived: false,
      });
    if (path === `${local}/contents/.ephor-upstream.json`)
      return Response.json(
        encoded({
          commit:
            url.searchParams.get("ref") === remote.prepared
              ? target
              : remote.version,
        }),
      );
    if (path === `${local}/contents/package.json`)
      return Response.json(encoded({ name: "ephor" }));
    if (path === `${local}/contents/.github/workflows/update-ephor.yml`)
      return Response.json(
        encoded(remote.protocol ? "# ephor-panel-protocol: 1" : "old updater"),
      );
    if (
      path === "/repos/rasmussensolutions/ephor/actions/workflows/ci.yml/runs"
    )
      return Response.json({ workflow_runs: [{ head_sha: target }] });
    if (path === `${local}/actions/workflows/update-ephor.yml/dispatches`) {
      remote.dispatched++;
      return new Response(null, { status: 204 });
    }
    if (path === `${local}/actions/workflows/update-ephor.yml/runs`)
      return Response.json({
        workflow_runs: [
          {
            id: 1,
            head_sha: base,
            display_title: `Ephor panel ${(await panel.state()).job?.id}`,
            status: remote.run === "running" ? "in_progress" : "completed",
            conclusion: remote.run,
            html_url: "https://github.com/acme/panel/actions/runs/1",
          },
        ],
      });
    if (path === `${local}/branches/main`)
      return Response.json({ commit: { sha: remote.branch } });
    if (path.startsWith(`${local}/branches/ephor-update`))
      return Response.json({ commit: { sha: remote.prepared } });
    if (path === `${local}/git/commits/${remote.prepared}`)
      return Response.json({ parents: [{ sha: remote.parent }] });
    if (path === `${local}/pulls` && init?.method === "POST") {
      remote.pr = true;
      return Response.json(pull());
    }
    if (path === `${local}/pulls`)
      return Response.json(remote.pr ? [pull()] : []);
    if (path === `${local}/pulls/7`) return Response.json(pull());
    if (path === `${local}/pulls/7/files`) return Response.json(remote.files);
    if (path === `${local}/actions/workflows/ci.yml/runs`)
      return Response.json({
        workflow_runs: [
          { head_sha: head, status: "completed", conclusion: remote.ci },
        ],
      });
    if (path === `${local}/commits/${head}/check-runs`)
      return Response.json({
        total_count: 1,
        check_runs: [{ status: "completed", conclusion: remote.check }],
      });
    if (path === `${local}/commits/${head}/status`)
      return Response.json({ state: "pending", total_count: 0 });
    if (path === `${local}/pulls/7/merge`) {
      remote.merged = true;
      remote.version = target;
      return Response.json({ merged: true, sha: merged });
    }
    throw new Error(`Unexpected GitHub request: ${path}`);
  }) as typeof fetch;
  panel = new PanelUpdates(f.env, request, previous);
  await panel.github.integrations.set("panel-github", {
    id: 1,
    slug: "updates",
    pem,
    webhookSecret: "unused",
  });
  await f.sql.query(
    "INSERT INTO ephor_panel_github_installation (id,account) VALUES ('99','acme')",
  );
  await panel.configure({
    installationId: "99",
    repositoryId: "123",
    host,
    deployment,
    confirmed: true,
  });
  return { ...f, panel, remote, calls, request };
}
const approval = { head, target, backupConfirmed: true };

test("panel update prepares and reviews an exact tested version, merges with an App token, and verifies the running version", async () => {
  const f = await setup();
  await f.panel.check();
  await f.panel.prepare();
  await f.panel.prepare();
  expect(f.remote.dispatched).toBe(1);
  const dispatch = f.calls.find((c) => c.path.endsWith("/dispatches"));
  expect(dispatch?.body).toMatchObject({
    ref: "main",
    inputs: { target, base },
  });
  expect((await f.panel.status(true)).progress?.stage).toBe("prepared");
  await f.panel.review();
  expect((await f.panel.status(true)).progress?.stage).toBe("ready");
  expect((await f.panel.status(true)).progress?.files?.[0]?.filename).toContain(
    "migrations",
  );
  await f.panel.install(approval);
  expect(f.calls.find((c) => c.path.endsWith("/merge"))).toMatchObject({
    method: "PUT",
    body: { sha: head, merge_method: "merge" },
  });
  expect((await f.panel.status(true)).progress?.stage).toBe("deploying");
  expect((await f.panel.state()).repositoryVersion).toBe(target);
  await expect(f.panel.prepare()).rejects.toThrow("PANEL_DEPLOYMENT_PENDING");
  const unavailable = (async () => {
    throw new Error("GitHub is unavailable");
  }) as unknown as typeof fetch;
  const updated = new PanelUpdates(f.env, unavailable, target);
  expect((await updated.status(true)).progress?.stage).toBe("updated");
  const issued = f.calls.filter((c) => c.path.endsWith("/access_tokens"));
  expect(
    issued.every((c) => JSON.stringify(c.body?.repository_ids) === "[123]"),
  ).toBe(true);
  expect(JSON.stringify(await f.panel.status())).not.toContain("scoped-token");
});

test("VPS/manual and Railway/Git deployments distinguish repository updates from running code", async () => {
  for (const [host, mode, stage] of [
    ["vps", "manual", "manual"],
    ["railway", "git", "deploying"],
    ["other", "manual", "manual"],
  ] as const) {
    const f = await setup(mode, host);
    await f.panel.prepare();
    await f.panel.review();
    await f.panel.install(approval);
    expect((await f.panel.status(true)).progress?.stage).toBe(stage);
    expect(
      (await new PanelUpdates(f.env, f.request, target).status(true)).progress
        ?.stage,
    ).toBe("updated");
  }
});

test("failed, missing, pending checks and repository rules cannot be bypassed", async () => {
  const f = await setup();
  await f.panel.prepare();
  await f.panel.review();
  for (const conclusion of ["failure", "cancelled", "", "action_required"]) {
    f.remote.ci = conclusion;
    await expect(f.panel.install(approval)).rejects.toThrow(
      "PANEL_CHECKS_PENDING",
    );
  }
  f.remote.ci = "success";
  f.remote.check = "failure";
  await expect(f.panel.install(approval)).rejects.toThrow(
    "PANEL_CHECKS_PENDING",
  );
  f.remote.check = "success";
  f.remote.mergeableState = "blocked";
  await expect(f.panel.install(approval)).rejects.toThrow(
    "PANEL_REVIEW_CHANGED",
  );
  expect(f.calls.some((c) => c.path.endsWith("/merge"))).toBe(false);
});

test("installation requires backup acknowledgement and the exact reviewed head and base", async () => {
  const f = await setup();
  await f.panel.prepare();
  await f.panel.review();
  await expect(
    f.panel.install({ ...approval, backupConfirmed: false }),
  ).rejects.toThrow("PANEL_REVIEW_CHANGED");
  await expect(f.panel.install({ ...approval, head: base })).rejects.toThrow(
    "PANEL_REVIEW_CHANGED",
  );
  f.remote.prHead = merged;
  await expect(f.panel.install(approval)).rejects.toThrow(
    "PANEL_REVIEW_CHANGED",
  );
  f.remote.prHead = head;
  f.remote.branch = merged;
  await expect(f.panel.install(approval)).rejects.toThrow(
    "PANEL_REVIEW_CHANGED",
  );
  expect((await f.panel.status(true)).progress?.stage).toBe("blocked");
  expect(f.calls.some((c) => c.path.endsWith("/merge"))).toBe(false);
});

test("protected configuration, existing migrations, workflows and modified preparation ancestry stop updates", async () => {
  const f = await setup();
  await f.panel.prepare();
  f.remote.parent = merged;
  await expect(f.panel.review()).rejects.toThrow("PANEL_REVIEW_CHANGED");
  f.remote.parent = base;
  await f.panel.review();
  for (const filename of [
    "wrangler.jsonc",
    "deploy/docker/compose.yaml",
    "railway.toml",
    ".github/workflows/ci.yml",
    "packages/api/migrations/sqlite/0001_auth.sql",
  ]) {
    f.remote.files = [
      { filename, status: "modified", additions: 1, deletions: 1, patch: "" },
    ];
    await expect(f.panel.install(approval)).rejects.toThrow(
      "PANEL_MANUAL_REVIEW",
    );
  }
});

test("legacy updater and changed repository identities fail before dispatch", async () => {
  const f = await setup();
  f.remote.protocol = false;
  await expect(f.panel.prepare()).rejects.toThrow("PANEL_WORKFLOW_UPGRADE");
  f.remote.protocol = true;
  f.remote.identity = 456;
  await expect(f.panel.prepare()).rejects.toThrow("PANEL_REPOSITORY_CHANGED");
  f.remote.identity = 123;
  f.remote.defaultBranch = "other";
  await expect(f.panel.prepare()).rejects.toThrow("PANEL_REPOSITORY_CHANGED");
  expect(f.remote.dispatched).toBe(0);
});

test("a failed preparation never creates a PR and mutation leases prevent concurrent work", async () => {
  const f = await setup();
  await f.panel.prepare();
  f.remote.run = "failure";
  expect((await f.panel.status(true)).progress?.stage).toBe("blocked");
  await expect(f.panel.review()).rejects.toThrow("PANEL_NOT_PREPARED");
  expect(f.remote.pr).toBe(false);
  await f.panel.change(async () => {
    await expect(f.panel.reset()).rejects.toThrow("PANEL_UPDATE_BUSY");
  });
  await f.panel.reset();
  expect((await f.panel.state()).job).toBeUndefined();
});

test("panel GitHub authorization is independent from service access and cannot exchange callback state", async () => {
  const f = await fixture();
  const services = new GitHubApp(
    f.sql,
    f.env.secret,
    "https://panel.example.com",
  );
  const updates = new GitHubApp(
    f.sql,
    f.env.secret,
    "https://panel.example.com",
    fetch,
    "panel",
  );
  const flow = await updates.start();
  expect(flow.manifest?.redirect_url).toBe(
    "https://panel.example.com/updates?github=register",
  );
  expect(flow.manifest?.default_permissions.contents).toBe("write");
  expect(flow.manifest?.default_permissions.actions).toBe("write");
  expect(flow.manifest?.hook_attributes.active).toBe(false);
  await expect(services.consume(flow.state, "register")).rejects.toThrow(
    "GITHUB_STATE_EXPIRED",
  );
  await updates.consume(flow.state, "register");
  await f.sql.query(
    "INSERT INTO ephor_github_installation (id,account) VALUES ('1','service')",
  );
  await updates.disconnect();
  expect((await services.status()).installations).toHaveLength(1);
  expect((await services.start()).manifest?.default_permissions.contents).toBe(
    "read",
  );
});

test("panel endpoints require owner authentication, same-origin JSON and fresh passkey", async () => {
  const f = await enrolled();
  expect((await f.app.request("/api/panel/status")).status).toBe(401);
  expect((await f.browser.request("/panel/status")).status).toBe(200);
  expect(
    (
      await f.browser.request(
        "/panel/reset",
        {},
        { origin: "https://evil.example" },
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await f.browser.request(
        "/panel/reset",
        {},
        { "content-type": "text/plain" },
      )
    ).status,
  ).toBe(415);
  await f.sql.query('UPDATE session SET "createdAt"=$1', [
    timestamp(Date.now() - 600000),
  ]);
  expect((await f.browser.request("/panel/reset", {})).status).toBe(403);
});
