import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AuthStore, FRESH_MS, randomToken } from "../src/auth/store";
import { MachineStore } from "../src/machines/store";
import { AgentOperations, schemas } from "../src/mcp/operations";
import { AgentAccess, policySchema } from "../src/mcp/policy";
import { Services } from "../src/services/store";
import { Browser, enrolled, origin, timestamp } from "./helpers";

async function setup() {
  const f = await enrolled();
  const project = await (
    await f.browser.request("/projects/create", { name: "Creatorical" })
  ).json();
  const other = await (
    await f.browser.request("/projects/create", { name: "Private" })
  ).json();
  const machine = await new MachineStore(f.sql).create("Production");
  await new MachineStore(f.sql).enroll(machine.token, randomToken());
  const policy = policySchema.parse({
    projectIds: [project.id],
    machineIds: [machine.id],
    manage: true,
    logs: true,
  });
  const issued = await (
    await f.browser.request("/mcp/connections", {
      name: "Test agent",
      policy,
      days: 30,
    })
  ).json();
  const operations = new AgentOperations(f.env);
  return { ...f, project, other, machine, policy, issued, operations };
}
async function rpc(
  f: Awaited<ReturnType<typeof setup>>,
  method: string,
  params: unknown = {},
  token = f.issued.token,
  extra: Record<string, string> = {},
) {
  const response = await f.app.request(`${origin}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-11-25",
      ...extra,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: response.status, data: await response.json() };
}
const spec = {
  image: "docker.io/library/nginx:latest",
  port: 3000,
  healthPath: "/",
  memoryMb: 256,
  cpus: 0.5,
};
test("existing connections can opt into future machines and projects without replacing credentials", async () => {
  const f = await setup();
  const legacy = { ...f.policy, machineIds: [], allProjects: true };
  delete (legacy as Partial<typeof legacy>).allMachines;
  await f.sql.query("UPDATE ephor_mcp_connection SET policy=$1 WHERE id=$2", [
    JSON.stringify(legacy),
    f.issued.id,
  ]);
  expect(
    (await new AgentAccess(f.env).connection(f.issued.id)).policy.allMachines,
  ).toBe(false);
  expect(
    (await rpc(f, "tools/call", { name: "list_machines", arguments: {} })).data
      .result.structuredContent.result,
  ).toEqual([]);
  const [before] = await f.sql.query<{
    name: string;
    policy: string;
    expires_at: number;
    token_hash: string;
  }>(
    "SELECT name,policy,expires_at,token_hash FROM ephor_mcp_connection WHERE id=$1",
    [f.issued.id],
  );
  const update = {
    id: f.issued.id,
    name: "Updated agent",
    policy: { ...legacy, allMachines: true },
    previousName: before?.name,
    previousPolicy: before?.policy,
  };
  expect(
    (await f.browser.request("/mcp/connections/update", update)).status,
  ).toBe(200);
  expect(
    (await f.browser.request("/mcp/connections/update", update)).status,
  ).toBe(409);
  const future = await new MachineStore(f.sql).create("Future machine");
  const project = await (
    await f.browser.request("/projects/create", { name: "Future project" })
  ).json();
  const machines = await rpc(f, "tools/call", {
    name: "list_machines",
    arguments: {},
  });
  expect(
    machines.data.result.structuredContent.result.map(
      (m: { id: string }) => m.id,
    ),
  ).toEqual(expect.arrayContaining([f.machine.id, future.id]));
  expect(
    (
      await rpc(f, "tools/call", {
        name: "machine_metrics",
        arguments: { machineId: future.id },
      })
    ).data.result.isError,
  ).not.toBe(true);
  expect(
    JSON.stringify(
      (await rpc(f, "tools/call", { name: "list_projects", arguments: {} }))
        .data,
    ),
  ).toContain(project.id);
  const proposal = (await f.operations.call(f.issued.id, "create_project", {
    name: "Needs approval",
    requestKey: "future-project-approval",
  })) as { operationId: string; status: string };
  expect(proposal.status).toBe("pending");
  expect(
    await f.sql.query("SELECT id FROM ephor_project WHERE name=$1", [
      "Needs approval",
    ]),
  ).toHaveLength(0);
  const [after] = await f.sql.query<{
    name: string;
    policy: string;
    expires_at: number;
    token_hash: string;
  }>(
    "SELECT name,policy,expires_at,token_hash FROM ephor_mcp_connection WHERE id=$1",
    [f.issued.id],
  );
  expect(after?.token_hash).toBe(before?.token_hash);
  expect(Number(after?.expires_at)).toBe(Number(before?.expires_at));
  expect(
    (
      await f.browser.request("/mcp/connections/update", {
        ...update,
        previousName: after?.name,
        previousPolicy: after?.policy,
        policy: { ...legacy, allMachines: false, manage: false, logs: false },
      })
    ).status,
  ).toBe(200);
  expect(
    (await rpc(f, "tools/call", { name: "list_machines", arguments: {} })).data
      .result.structuredContent.result,
  ).toEqual([]);
  expect(
    (
      await rpc(f, "tools/call", {
        name: "machine_metrics",
        arguments: { machineId: future.id },
      })
    ).data.result.isError,
  ).toBe(true);
  expect(
    (
      await f.browser.request("/mcp/decide", {
        id: proposal.operationId,
        approve: true,
      })
    ).status,
  ).toBe(403);
  expect(
    await f.sql.query("SELECT id FROM ephor_project WHERE name=$1", [
      "Needs approval",
    ]),
  ).toHaveLength(0);
});
test("permission edits require owner passkeys, reject agent credentials, and cannot revive revoked or expired connections", async () => {
  const f = await setup();
  const input = {
    id: f.issued.id,
    name: "Changed",
    policy: { ...f.policy, allMachines: true },
    previousName: "Test agent",
    previousPolicy: JSON.stringify(f.policy),
  };
  expect(
    (
      await f.app.request(`${origin}/api/mcp/connections/update`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          authorization: `Bearer ${f.issued.token}`,
        },
        body: JSON.stringify(input),
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await f.browser.request("/mcp/connections/update", input, {
        Origin: "https://evil.example",
      })
    ).status,
  ).toBe(403);
  await f.sql.query('UPDATE session SET "createdAt"=$1', [
    timestamp(Date.now() - FRESH_MS - 1000),
  ]);
  expect(
    (await f.browser.request("/mcp/connections/update", input)).status,
  ).toBe(403);
  await f.sql.query('UPDATE session SET "createdAt"=$1', [
    timestamp(Date.now()),
  ]);
  await f.sql.query(
    "UPDATE ephor_mcp_connection SET expires_at=$1 WHERE id=$2",
    [Date.now() - 1, f.issued.id],
  );
  expect(
    (await f.browser.request("/mcp/connections/update", input)).status,
  ).toBe(401);
  await f.sql.query(
    "UPDATE ephor_mcp_connection SET expires_at=$1,revoked=1 WHERE id=$2",
    [Date.now() + 60000, f.issued.id],
  );
  expect(
    (await f.browser.request("/mcp/connections/update", input)).status,
  ).toBe(401);
});
test("permission changes during approval prevent stale authorization from claiming an operation", async () => {
  const f = await setup();
  const broad = { ...f.policy, allProjects: true };
  await f.sql.query("UPDATE ephor_mcp_connection SET policy=$1 WHERE id=$2", [
    JSON.stringify(broad),
    f.issued.id,
  ]);
  const proposal = (await f.operations.call(f.issued.id, "create_project", {
    name: "Race project",
    requestKey: "permission-race-001",
  })) as { operationId: string };
  const authorize = f.operations.authorize.bind(f.operations);
  f.operations.authorize = async (...args) => {
    await authorize(...args);
    await f.sql.query("UPDATE ephor_mcp_connection SET policy=$1 WHERE id=$2", [
      JSON.stringify({ ...broad, manage: false }),
      f.issued.id,
    ]);
  };
  await expect(f.operations.decide(proposal.operationId, true)).rejects.toThrow(
    "MCP_APPROVAL_EXPIRED_OR_USED",
  );
  expect(
    await f.sql.query("SELECT id FROM ephor_project WHERE name=$1", [
      "Race project",
    ]),
  ).toHaveLength(0);
});
test("real Bun HTTP transport accepts MCP JSON bodies", async () => {
  const f = await setup();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => f.app.fetch(request),
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${f.issued.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_projects", arguments: {} },
      }),
    });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.result?.isError).not.toBe(true);
    expect(JSON.stringify(body)).toContain("Creatorical");
  } finally {
    await server.stop(true);
  }
});
test("real MCP SDK connects, discovers tools, and scopes project discovery", async () => {
  const f = await setup();
  const client = new Client({ name: "integration-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${origin}/mcp`),
    {
      requestInit: { headers: { authorization: `Bearer ${f.issued.token}` } },
      fetch: async (input, init) =>
        f.app.fetch(
          new Request(input instanceof Request ? input : String(input), init),
        ),
    },
  );
  await client.connect(transport);
  const tools = await client.listTools();
  expect(tools.tools.some((t) => t.name === "deploy_service")).toBe(true);
  expect(tools.tools.some((t) => t.name.includes("reveal"))).toBe(false);
  const result = await client.callTool({
    name: "list_projects",
    arguments: {},
  });
  expect(JSON.stringify(result)).toContain("Creatorical");
  expect(JSON.stringify(result)).not.toContain("Private");
  await client.close();
});
test("cached SDK discovery survives permission edits while calls and approvals enforce current grants", async () => {
  const f = await setup();
  const readonly = policySchema.parse({ allProjects: true });
  const update = async (policy: typeof readonly) => {
    const { row } = await new AgentAccess(f.env).connection(f.issued.id);
    expect(
      (
        await f.browser.request("/mcp/connections/update", {
          id: row.id,
          name: row.name,
          previousName: row.name,
          previousPolicy: row.policy,
          policy,
        })
      ).status,
    ).toBe(200);
  };
  await update(readonly);
  const client = new Client({ name: "cached-discovery-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${f.issued.token}` } },
      fetch: async (input, init) =>
        f.app.fetch(
          new Request(input instanceof Request ? input : String(input), init),
        ),
    }),
  );
  try {
    const cached = await client.listTools();
    for (const name of ["create_project", "read_logs", "list_repositories"])
      expect(cached.tools.some((t) => t.name === name)).toBe(true);
    expect(
      cached.tools.find((t) => t.name === "create_project")?.annotations
        ?.readOnlyHint,
    ).toBe(false);
    const create = () =>
      client.callTool({
        name: "create_project",
        arguments: { name: "Approved project", requestKey: "cached-create-01" },
      });
    const denied = (result: Awaited<ReturnType<typeof client.callTool>>) => {
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: "MCP_SCOPE_DENIED" },
      ]);
    };
    denied(await create());
    denied(await client.callTool({ name: "list_repositories", arguments: {} }));
    denied(
      await client.callTool({
        name: "read_logs",
        arguments: {
          serviceId: crypto.randomUUID(),
          kind: "runtime",
          requestKey: "cached-logs-01",
        },
      }),
    );
    expect(
      await f.sql.query("SELECT id FROM ephor_mcp_operation"),
    ).toHaveLength(0);

    const broad = { ...readonly, manage: true, logs: true, repositories: true };
    // No client reconnect or discovery refresh between the edit and this call.
    await update(broad);
    const proposed = await create();
    expect(proposed.isError).not.toBe(true);
    const { result: proposal } = proposed.structuredContent as {
      result: { operationId: string; status: string };
    };
    expect(proposal.status).toBe("pending");
    expect(
      await f.sql.query("SELECT id FROM ephor_project WHERE name=$1", [
        "Approved project",
      ]),
    ).toHaveLength(0);
    expect(await client.listTools()).toEqual(cached);

    await update(readonly);
    denied(await create());
    expect(
      (
        await f.browser.request("/mcp/decide", {
          id: proposal.operationId,
          approve: true,
        })
      ).status,
    ).toBe(403);
    expect(await client.listTools()).toEqual(cached);

    // Manage alone still cannot create a project outside the project grant.
    await update({ ...broad, allProjects: false });
    denied(await create());
    await update(broad);
    await f.sql.query('UPDATE session SET "createdAt"=$1', [
      timestamp(Date.now() - FRESH_MS - 1000),
    ]);
    expect(
      (
        await f.browser.request("/mcp/decide", {
          id: proposal.operationId,
          approve: true,
        })
      ).status,
    ).toBe(403);
    expect(
      await f.sql.query("SELECT id FROM ephor_project WHERE name=$1", [
        "Approved project",
      ]),
    ).toHaveLength(0);
    await f.sql.query('UPDATE session SET "createdAt"=$1', [
      timestamp(Date.now()),
    ]);
    expect(
      (
        await f.browser.request("/mcp/decide", {
          id: proposal.operationId,
          approve: true,
        })
      ).status,
    ).toBe(200);
    expect(
      await f.sql.query("SELECT id FROM ephor_project WHERE name=$1", [
        "Approved project",
      ]),
    ).toHaveLength(1);
    expect(await f.sql.query("SELECT id FROM ephor_service")).toHaveLength(0);
  } finally {
    await client.close();
  }
});
test("advertised MCP patterns work in Python consumers and preserve name validation", async () => {
  const f = await setup();
  const listed = await rpc(f, "tools/list");
  expect(listed.status).toBe(200);
  // Python JSON Schema validators compile patterns with re. SDK-only tests
  // miss JavaScript Unicode escapes that make clients reject the entire catalog.
  const checked = Bun.spawnSync(
    [
      "python3",
      "-c",
      `import json, re, sys
def check(node):
    if isinstance(node, dict):
        if "pattern" in node:
            re.compile(node["pattern"])
        for pattern in node.get("patternProperties", {}):
            re.compile(pattern)
        for value in node.values():
            check(value)
    elif isinstance(node, list):
        for value in node:
            check(value)
tools = json.load(sys.stdin)["tools"]
for tool in tools:
    try:
        check(tool["inputSchema"])
    except re.error as error:
        raise AssertionError(tool["name"] + ": " + str(error)) from error
    if tool["name"] in ("create_project", "create_service", "create_catalog_service"):
        pattern = re.compile(tool["inputSchema"]["properties"]["name"]["pattern"])
        for value in ("Creatorical", "Café", "日本語 🚀", "App (prod)"):
            assert pattern.search(value), (tool["name"], value)
        for code in (*range(32), *range(127, 160)):
            assert not pattern.search("A" + chr(code) + "Z"), (tool["name"], code)
`,
    ],
    { stdin: Buffer.from(JSON.stringify(listed.data.result)) },
  );
  expect(checked.exitCode, checked.stderr.toString()).toBe(0);
  for (const tool of [
    "create_project",
    "create_service",
    "create_catalog_service",
  ] as const) {
    const name = schemas[tool].shape.name;
    for (const value of ["Creatorical", "Café", "日本語 🚀", "App (prod)"])
      expect(name.safeParse(value).success).toBe(true);
    for (let code = 0; code < 160; code++) {
      if (code >= 32 && code < 127) continue;
      expect(name.safeParse(`A${String.fromCharCode(code)}Z`).success).toBe(
        false,
      );
    }
    expect(name.parse("  Creatorical  ")).toBe("Creatorical");
    expect(name.safeParse(" ").success).toBe(false);
    expect(name.safeParse("x".repeat(81)).success).toBe(false);
  }
});
test("MCP rejects browser cookies, foreign origins, invalid tokens and revoked connections", async () => {
  const f = await setup();
  expect((await rpc(f, "tools/list", {}, "bad")).status).toBe(401);
  expect(
    (
      await rpc(f, "tools/list", {}, f.issued.token, {
        origin: "https://evil.example",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await f.app.request(`${origin}/mcp`, {
        method: "POST",
        headers: {
          cookie: [...f.browser.cookies]
            .map(([k, v]) => `${k}=${v}`)
            .join("; "),
          "content-type": "application/json",
        },
        body: "{}",
      })
    ).status,
  ).toBe(401);
  const tokenRow = await f.sql.query<{ token_hash: string }>(
    "SELECT token_hash FROM ephor_mcp_connection WHERE id=$1",
    [f.issued.id],
  );
  expect(JSON.stringify(tokenRow)).not.toContain(f.issued.token);
  await f.browser.request("/mcp/revoke", { id: f.issued.id });
  expect((await rpc(f, "tools/list")).status).toBe(401);
});
test("create service requires owner approval, cannot be replayed, and deploy requires another approval", async () => {
  const f = await setup();
  const args = {
    requestKey: "create-app-1",
    projectId: f.project.id,
    machineId: f.machine.id,
    name: "Web",
    source: { type: "image" },
    spec,
  };
  const proposal = (await f.operations.call(
    f.issued.id,
    "create_service",
    args,
  )) as { operationId: string };
  expect(await f.sql.query("SELECT id FROM ephor_service")).toHaveLength(0);
  expect(
    (
      (await f.operations.call(f.issued.id, "create_service", args)) as {
        operationId: string;
      }
    ).operationId,
  ).toBe(proposal.operationId);
  expect(
    (
      await new Browser(f.app).request("/mcp/decide", {
        id: proposal.operationId,
        approve: true,
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await f.browser.request(
        "/mcp/decide",
        { id: proposal.operationId, approve: true },
        { origin: "https://evil.example" },
      )
    ).status,
  ).toBe(403);
  const decisions = await Promise.all([
    f.browser.request("/mcp/decide", {
      id: proposal.operationId,
      approve: true,
    }),
    f.browser.request("/mcp/decide", {
      id: proposal.operationId,
      approve: true,
    }),
  ]);
  expect(decisions.map((r) => r.status).sort()).toEqual([200, 409]);
  const services = await f.sql.query<{ id: string }>(
    "SELECT id FROM ephor_service",
  );
  expect(services).toHaveLength(1);
  const serviceId = services[0]?.id;
  if (!serviceId) throw new Error("Service was not created");
  expect(await f.sql.query("SELECT id FROM ephor_deployment")).toHaveLength(0);
  const memberships = await f.sql.query(
    "SELECT * FROM ephor_project_service WHERE service_id=$1",
    [serviceId],
  );
  expect(memberships[0]?.project_id).toBe(f.project.id);
  await expect(
    f.operations.call(f.issued.id, "create_service", {
      ...args,
      name: "Different",
    }),
  ).rejects.toThrow("MCP_REQUEST_KEY_CONFLICT");
  const deploy = (await f.operations.call(f.issued.id, "deploy_service", {
    requestKey: "deploy-app-1",
    serviceId,
  })) as { operationId: string };
  expect(
    (await f.operations.status(f.issued.id, deploy.operationId)).status,
  ).toBe("pending");
  const executor = new Services(f.sql, f.env.secret);
  const enrollment = await executor.issueWorker(f.machine.id);
  await executor.enroll(enrollment, randomToken());
  await executor.heartbeat(f.machine.id, 6);
  expect(
    (
      await f.browser.request("/mcp/decide", {
        id: deploy.operationId,
        approve: true,
      })
    ).status,
  ).toBe(200);
  const claimed = await executor.next(f.machine.id, 6);
  expect(claimed?.action).toBe("deploy");
  await executor.report(f.machine.id, {
    id: claimed?.id,
    status: "succeeded",
    digest: `docker.io/library/nginx@sha256:${"a".repeat(64)}`,
  });
  await executor.runtime(f.machine.id, {
    id: serviceId,
    status: "running",
    container: "fixture",
    logs: "",
    metrics: null,
  });
  const verified = (await f.operations.call(f.issued.id, "inspect_service", {
    serviceId,
  })) as {
    health: { status: string; stale: boolean };
    deployments: { status: string }[];
  };
  expect(verified.health.stale).toBe(false);
  expect(verified.deployments[0]?.status).toBe("succeeded");
});
test("project and machine boundaries, unknown fields, reference scopes and readonly grants fail closed", async () => {
  const f = await setup();
  await expect(
    f.operations.call(f.issued.id, "list_services", { projectId: f.other.id }),
  ).rejects.toThrow("MCP_SCOPE_DENIED");
  await expect(
    f.operations.call(f.issued.id, "machine_metrics", {
      machineId: crypto.randomUUID(),
    }),
  ).rejects.toThrow("MCP_SCOPE_DENIED");
  await expect(
    f.operations.call(f.issued.id, "create_project", {
      name: "Escape",
      requestKey: "escape-01",
    }),
  ).rejects.toThrow("MCP_SCOPE_DENIED");
  await expect(
    f.operations.call(f.issued.id, "create_service", {
      requestKey: "escape-02",
      projectId: f.project.id,
      machineId: f.machine.id,
      name: "Web",
      source: { type: "image" },
      spec: { ...spec, environment: { ESCAPE: "secret" } },
    }),
  ).rejects.toThrow();
  const readonly = await new AgentAccess(f.env).issue(
    "Readonly",
    policySchema.parse({ projectIds: [f.project.id] }),
    1,
  );
  const denied = await rpc(
    f,
    "tools/call",
    { name: "create_service", arguments: {} },
    readonly.token,
  );
  expect(JSON.stringify(denied.data)).not.toContain("operationId");
  await expect(
    f.operations.call(readonly.id, "read_logs", {
      requestKey: "logs-0001",
      serviceId: crypto.randomUUID(),
      kind: "runtime",
    }),
  ).rejects.toThrow("MCP_SCOPE_DENIED");
});
test("ordinary reads never expose environment, registry credentials or logs; disclosure needs approval", async () => {
  const f = await setup(),
    services = new Services(f.sql, f.env.secret);
  const secret = "super-private-secret";
  const created = await services.create(
    {
      machineId: f.machine.id,
      name: "App",
      spec: {
        ...spec,
        environment: { API_KEY: secret },
        registry: {
          server: "docker.io",
          username: "user",
          password: "registry-private",
        },
      },
    },
    { type: "image" },
  );
  await f.browser.request(`/projects/${f.project.id}/add`, {
    serviceId: created.id,
  });
  await f.sql.query(
    "UPDATE ephor_service SET runtime=$1,runtime_at=$2 WHERE id=$3",
    [
      JSON.stringify({
        status: "running",
        logs: `API_KEY=${secret}\nprivate output`,
        metrics: null,
      }),
      Date.now(),
      created.id,
    ],
  );
  const inspection = await f.operations.call(f.issued.id, "inspect_service", {
    serviceId: created.id,
  });
  for (const hidden of [secret, "registry-private", "private output"])
    expect(JSON.stringify(inspection)).not.toContain(hidden);
  const variables = (await f.operations.call(f.issued.id, "list_variables", {
    serviceId: created.id,
  })) as { revision: string };
  expect(JSON.stringify(variables)).not.toContain(secret);
  const update = (await f.operations.call(f.issued.id, "set_variables", {
    requestKey: "variables-01",
    serviceId: created.id,
    revision: variables.revision,
    set: { TOKEN: "new-private-secret" },
  })) as { operationId: string };
  expect(JSON.stringify(await f.operations.review())).not.toContain(
    "new-private-secret",
  );
  expect(
    JSON.stringify(
      await f.sql.query("SELECT payload FROM ephor_mcp_operation"),
    ),
  ).not.toContain("new-private-secret");
  const foreign = await services.create(
    {
      machineId: f.machine.id,
      name: "Private",
      spec: { ...spec, environment: {} },
    },
    { type: "image" },
  );
  await f.browser.request(`/projects/${f.other.id}/add`, {
    serviceId: foreign.id,
  });
  await expect(
    f.operations.call(f.issued.id, "set_variables", {
      requestKey: "reference-1",
      serviceId: created.id,
      revision: variables.revision,
      set: { DATABASE_URL: `\${{${foreign.id}.DATABASE_URL}}` },
    }),
  ).rejects.toThrow("MCP_SCOPE_DENIED");
  await f.browser.request("/mcp/decide", {
    id: update.operationId,
    approve: true,
  });
  const logs = (await f.operations.call(f.issued.id, "read_logs", {
    requestKey: "logs-001",
    serviceId: created.id,
    kind: "runtime",
  })) as { operationId: string };
  expect(
    JSON.stringify(await f.operations.status(f.issued.id, logs.operationId)),
  ).not.toContain("private output");
  await f.browser.request("/mcp/decide", {
    id: logs.operationId,
    approve: true,
  });
  const output = JSON.stringify(
    await f.operations.status(f.issued.id, logs.operationId),
  );
  expect(output).toContain("private output");
  expect(output).not.toContain(secret);
});
test("expired, changed, denied and recovered-owner approvals cannot execute", async () => {
  const f = await setup();
  const created = await new Services(f.sql, f.env.secret).create(
    {
      machineId: f.machine.id,
      name: "App",
      spec: { ...spec, environment: {} },
    },
    { type: "image" },
  );
  await f.browser.request(`/projects/${f.project.id}/add`, {
    serviceId: created.id,
  });
  const propose = async (requestKey: string) =>
    (await f.operations.call(f.issued.id, "stop_service", {
      requestKey,
      serviceId: created.id,
    })) as { operationId: string };
  const changed = await propose("changed-01");
  await f.sql.query("UPDATE ephor_service SET auto_deploy=1 WHERE id=$1", [
    created.id,
  ]);
  expect(
    (
      await f.browser.request("/mcp/decide", {
        id: changed.operationId,
        approve: true,
      })
    ).status,
  ).toBe(409);
  const expired = await propose("expired-01");
  await f.sql.query("UPDATE ephor_mcp_operation SET expires_at=0 WHERE id=$1", [
    expired.operationId,
  ]);
  expect(
    (
      await f.browser.request("/mcp/decide", {
        id: expired.operationId,
        approve: true,
      })
    ).status,
  ).toBe(409);
  const denied = await propose("denied-001");
  await f.browser.request("/mcp/decide", {
    id: denied.operationId,
    approve: false,
  });
  expect(
    (
      await f.browser.request("/mcp/decide", {
        id: denied.operationId,
        approve: true,
      })
    ).status,
  ).toBe(409);
  await new AuthStore(f.sql).change((s) => {
    s.epoch++;
  });
  expect((await rpc(f, "tools/list")).status).toBe(401);
});
test("owner mutations require a fresh passkey and oversized MCP requests fail before dispatch", async () => {
  const f = await setup();
  await f.sql.query('UPDATE session SET "createdAt"=$1', [
    timestamp(Date.now() - FRESH_MS - 1000),
  ]);
  expect(
    (await f.browser.request("/mcp/revoke", { id: f.issued.id })).status,
  ).toBe(403);
  expect(
    (
      await f.browser.request("/mcp/connections", {
        name: "No",
        policy: f.policy,
      })
    ).status,
  ).toBe(403);
  const response = await f.app.request(`${origin}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${f.issued.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ data: "x".repeat(40000) }),
  });
  expect(response.status).toBe(413);
});
test("OAuth requires explicit consent and PKCE, exact redirect/resource binding, single-use codes", async () => {
  const f = await setup();
  const redirect = "http://127.0.0.1:9898/callback";
  const registration = await f.app.request(`${origin}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Test OAuth",
      redirect_uris: [redirect],
    }),
  });
  const { client_id } = await registration.json();
  expect(registration.status).toBe(201);
  const verifier = randomToken(),
    challenge = createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({
    client_id,
    redirect_uri: redirect,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "state123",
    resource: `${origin}/mcp`,
    scope: "ephor",
    ui_locales: "en-US",
    // Extension fields must never become consent or permission inputs.
    approve: "true",
    policy: '{"allProjects":true,"manage":true}',
  });
  for (const name of [
    "client_id",
    "redirect_uri",
    "resource",
    "state",
    "code_challenge",
    "scope",
  ]) {
    const duplicate = new URLSearchParams(query);
    duplicate.append(name, query.get(name) ?? "");
    expect(
      (await f.app.request(`${origin}/oauth/authorize?${duplicate}`)).status,
    ).toBe(400);
  }
  const authorize = await f.app.request(`${origin}/oauth/authorize?${query}`);
  expect(authorize.status).toBe(302);
  const pendingId = new URL(
    authorize.headers.get("location") ?? "",
  ).searchParams.get("authorization");
  const [pending] = await f.env.sql.query<{ request: string; status: string }>(
    "SELECT request,status FROM ephor_mcp_oauth WHERE id=$1",
    [pendingId],
  );
  expect(pending?.status).toBe("pending");
  const stored = JSON.parse(pending?.request ?? "{}");
  expect(stored.ui_locales).toBeUndefined();
  expect(stored.approve).toBeUndefined();
  expect(stored.policy).toBeUndefined();
  const consent = await f.browser.request("/mcp/authorize", {
    id: pendingId,
    approve: true,
    name: "OAuth client",
    policy: f.policy,
    days: 30,
  });
  expect(consent.status).toBe(200);
  const callback = new URL((await consent.json()).redirect);
  expect(callback.searchParams.get("state")).toBe("state123");
  const tokenRequest = (overrides: Record<string, string> = {}) =>
    f.app.request(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: callback.searchParams.get("code") ?? "",
        client_id,
        redirect_uri: redirect,
        resource: `${origin}/mcp`,
        code_verifier: verifier,
        ...overrides,
      }).toString(),
    });
  expect((await tokenRequest({ code_verifier: randomToken() })).status).toBe(
    400,
  );
  expect(
    (await tokenRequest({ resource: "https://evil.example/mcp" })).status,
  ).toBe(400);
  expect(
    (await tokenRequest({ redirect_uri: "https://evil.example/callback" }))
      .status,
  ).toBe(400);
  const tokenResponse = await tokenRequest();
  expect(tokenResponse.status).toBe(200);
  expect((await tokenRequest()).status).toBe(400);
  const tokens = await tokenResponse.json();
  const token = tokens.access_token;
  expect((await rpc(f, "tools/list", {}, token)).status).toBe(200);
  const [connection] = await f.sql.query<{
    id: string;
    name: string;
    policy: string;
  }>("SELECT id,name,policy FROM ephor_mcp_connection WHERE name=$1", [
    "OAuth client",
  ]);
  expect(
    (
      await f.browser.request("/mcp/connections/update", {
        id: connection?.id,
        name: "Edited OAuth client",
        policy: { ...f.policy, allMachines: true },
        previousName: connection?.name,
        previousPolicy: connection?.policy,
      })
    ).status,
  ).toBe(200);
  const futureMachine = await new MachineStore(f.sql).create(
    "OAuth future machine",
  );
  expect(
    JSON.stringify(
      (
        await rpc(
          f,
          "tools/call",
          { name: "list_machines", arguments: {} },
          token,
        )
      ).data,
    ),
  ).toContain(futureMachine.id);
  const refresh = (value: string) =>
    f.app.request(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: value,
        client_id,
        resource: `${origin}/mcp`,
      }).toString(),
    });
  const rotated = await refresh(tokens.refresh_token);
  expect(rotated.status).toBe(200);
  const rotatedTokens = await rotated.json();
  expect(rotatedTokens.refresh_token).not.toBe(tokens.refresh_token);
  expect(
    (await rpc(f, "tools/list", {}, rotatedTokens.access_token)).status,
  ).toBe(200);
  expect((await refresh(tokens.refresh_token)).status).toBe(400);
  expect(
    (await rpc(f, "tools/list", {}, rotatedTokens.access_token)).status,
  ).toBe(401);
  query.set("redirect_uri", "https://evil.example/callback");
  expect(
    (await f.app.request(`${origin}/oauth/authorize?${query}`)).status,
  ).toBe(400);
});
