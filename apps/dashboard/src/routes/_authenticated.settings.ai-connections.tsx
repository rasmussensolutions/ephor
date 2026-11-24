import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { SettingsPage, SettingsSection } from "@/components/settings-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, signIn } from "@/lib/auth";

interface Data {
  endpoint: string;
  connections: {
    id: string;
    name: string;
    policy: string;
    revoked: number;
    expires_at: number;
  }[];
  operations: {
    id: string;
    name: string;
    tool: string;
    status: string;
    expiresAt: number;
    args: Record<string, unknown>;
    commit?: string;
    repository?: string;
    target?: unknown;
  }[];
  authorizations: { id: string; name: string; request: string }[];
}
export const Route = createFileRoute("/_authenticated/settings/ai-connections")(
  {
    head: () => ({ meta: [{ title: "AI connections — Ephor" }] }),
    loader: async () => {
      const [data, projects, machines] = await Promise.all([
        api<Data>("/mcp/connections"),
        api<{ projects: { id: string; name: string }[] }>("/projects"),
        api<{ machines: { id: string; name: string }[] }>("/machines"),
      ]);
      return { data, projects: projects.projects, machines: machines.machines };
    },
    component: Connections,
  },
);
function Connections() {
  const { data, projects, machines } = Route.useLoaderData(),
    router = useRouter();
  const [name, setName] = useState("My AI agent"),
    [token, setToken] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [editing, setEditing] = useState<Data["connections"][number] | null>(
    null,
  );
  const [projectIds, setProjects] = useState<string[]>([]),
    [machineIds, setMachines] = useState<string[]>([]);
  const [allProjects, setAll] = useState(false),
    [allMachines, setAllMachines] = useState(false),
    [manage, setManage] = useState(false),
    [logs, setLogs] = useState(false),
    [repositories, setRepos] = useState(false);
  const policy = {
    projectIds,
    machineIds,
    allProjects,
    allMachines,
    manage,
    logs,
    repositories,
  };
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden && !busy) void router.invalidate();
    }, 10000);
    return () => window.clearInterval(timer);
  }, [router, busy]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await signIn();
      await action();
      await router.invalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }
  const checkbox = (
    label: string,
    checked: boolean,
    change: (v: boolean) => void,
  ) => (
    <label className="flex items-start gap-3 text-sm">
      <input
        type="checkbox"
        className="mt-1"
        checked={checked}
        disabled={busy}
        onChange={(e) => change(e.target.checked)}
      />
      {label}
    </label>
  );
  function select(current: string[], value: string, checked: boolean) {
    return checked ? [...current, value] : current.filter((v) => v !== value);
  }
  function editConnection(connection: Data["connections"][number] | null) {
    const p = connection ? JSON.parse(connection.policy) : {};
    setEditing(connection);
    setName(connection?.name ?? "My AI agent");
    setProjects(p.projectIds ?? []);
    setMachines(p.machineIds ?? []);
    setAll(p.allProjects ?? false);
    setAllMachines(p.allMachines ?? false);
    setManage(p.manage ?? false);
    setLogs(p.logs ?? false);
    setRepos(p.repositories ?? false);
    setToken("");
    setError("");
    if (connection)
      document
        .getElementById("connection-permissions")
        ?.scrollIntoView({ behavior: "smooth" });
  }
  return (
    <SettingsPage
      title="AI connections"
      description="Connect an AI client to this Ephor instance. Access is limited to the permissions you select, and can be revoked at any time."
    >
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="settings-surface space-y-3 rounded-xl p-5 text-sm">
        <p>MCP endpoint</p>
        <code className="block break-all select-all">{data.endpoint}</code>
        <p className="text-muted-foreground">
          Add this URL to a client that supports remote MCP and OAuth, or create
          a token below. All infrastructure changes and log disclosures require
          your passkey approval here. Stored secret values cannot be read
          through MCP.
        </p>
      </div>
      <SettingsSection
        title={
          editing
            ? `Edit permissions: ${editing.name}`
            : "Connection permissions"
        }
      >
        <div
          id="connection-permissions"
          className="settings-surface space-y-4 rounded-xl p-5"
        >
          {editing && (
            <p className="text-sm text-muted-foreground">
              Save with your passkey to apply these permissions to the existing
              connection. Its credentials and expiration date stay the same.
              Changes do not cancel work already running.
            </p>
          )}
          <label
            htmlFor="mcp-connection-name"
            className="block space-y-2 text-sm"
          >
            Connection name
            <Input
              id="mcp-connection-name"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          {checkbox(
            "Read all current and future projects",
            allProjects,
            setAll,
          )}
          {!allProjects && (
            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm font-medium">
                Projects this agent can access
              </legend>
              {projects.map((p) => (
                <div key={p.id}>
                  {checkbox(p.name, projectIds.includes(p.id), (v) =>
                    setProjects(select(projectIds, p.id, v)),
                  )}
                </div>
              ))}
            </fieldset>
          )}
          {checkbox(
            "Access all current and future machines",
            allMachines,
            setAllMachines,
          )}
          {!allMachines && (
            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm font-medium">
                Machines available for new services and machine metrics
              </legend>
              {machines.map((m) => (
                <div key={m.id}>
                  {checkbox(m.name, machineIds.includes(m.id), (v) =>
                    setMachines(select(machineIds, m.id, v)),
                  )}
                </div>
              ))}
            </fieldset>
          )}
          {checkbox(
            "Request changes to authorized projects and services (approval required each time)",
            manage,
            setManage,
          )}
          {checkbox(
            "Request application/build logs (separate disclosure approval required)",
            logs,
            setLogs,
          )}
          {checkbox(
            "Discover repositories in all connected GitHub installations",
            repositories,
            setRepos,
          )}
          <p className="text-xs text-muted-foreground">
            New connections expire after 30 days. Project access includes
            services added to those projects later. Deploying code gives that
            workload access to its configured secrets; review repository,
            domains and changes carefully.
          </p>
          {editing ? (
            <div className="flex gap-2">
              <Button
                disabled={busy || !name.trim()}
                onClick={() =>
                  void run(async () => {
                    await api("/mcp/connections/update", {
                      id: editing.id,
                      name,
                      policy,
                      previousName: editing.name,
                      previousPolicy: editing.policy,
                    });
                    editConnection(null);
                  })
                }
              >
                Save permissions
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => editConnection(null)}
              >
                Cancel editing
              </Button>
            </div>
          ) : (
            <Button
              disabled={busy || !name.trim()}
              onClick={() =>
                void run(async () => {
                  const result = await api<{ token: string }>(
                    "/mcp/connections",
                    { name, policy, days: 30 },
                  );
                  setToken(result.token);
                })
              }
            >
              Create access token
            </Button>
          )}
          {token && (
            <div className="space-y-3 rounded-lg border p-4">
              <p className="text-sm">
                Copy this token into your AI client’s secure credential
                settings. It is shown once; do not paste it into chat.
              </p>
              <code className="block break-all select-all text-sm">
                {token}
              </code>
              <Button variant="outline" onClick={() => setToken("")}>
                Hide token
              </Button>
            </div>
          )}
        </div>
      </SettingsSection>
      {!editing && data.authorizations.length > 0 && (
        <SettingsSection title="Clients requesting access">
          {data.authorizations.map((a) => {
            const q = JSON.parse(a.request) as { redirect_uri: string };
            return (
              <div
                key={a.id}
                className="settings-surface space-y-3 rounded-xl p-5 text-sm"
              >
                <p className="font-medium">{a.name}</p>
                <p>
                  Only approve a connection you started. Client names are
                  supplied by the client.
                </p>
                <p className="break-all">Return address: {q.redirect_uri}</p>
                <p>
                  The permissions selected above will apply to this connection.
                </p>
                <div className="flex gap-2">
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const result = await api<{ redirect: string }>(
                          "/mcp/authorize",
                          {
                            id: a.id,
                            approve: true,
                            name: name || a.name,
                            policy,
                            days: 30,
                          },
                        );
                        window.location.assign(result.redirect);
                      })
                    }
                  >
                    Approve connection
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await api("/mcp/authorize", {
                          id: a.id,
                          approve: false,
                          name,
                          policy,
                          days: 30,
                        });
                      })
                    }
                  >
                    Deny
                  </Button>
                </div>
              </div>
            );
          })}
        </SettingsSection>
      )}
      <SettingsSection title="Action approvals">
        {!data.operations.length && (
          <p className="px-5 text-sm text-muted-foreground">
            No recent requests. This page refreshes automatically.
          </p>
        )}
        {data.operations.map((o) => (
          <div
            key={o.id}
            className="settings-surface space-y-3 rounded-xl p-5 text-sm"
          >
            <p className="font-medium">
              {o.name} · {o.tool.replaceAll("_", " ")}
            </p>
            <p>
              {o.status} · Expires {new Date(o.expiresAt).toLocaleString()}
            </p>
            {o.tool === "read_logs" && (
              <p className="font-medium text-destructive">
                Approval sends application output to the AI client and
                potentially its model provider. Logs may contain secrets even
                after redaction.
              </p>
            )}
            {o.repository && <p>Repository: {o.repository}</p>}
            {o.commit && <p className="break-all">Commit: {o.commit}</p>}
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">
              {JSON.stringify(
                { currentService: o.target, requested: o.args },
                null,
                2,
              )}
            </pre>
            {o.status === "pending" && (
              <div className="flex gap-2">
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api("/mcp/decide", { id: o.id, approve: true });
                    })
                  }
                >
                  Approve and execute
                </Button>
                <Button
                  disabled={busy}
                  variant="outline"
                  onClick={() =>
                    void run(async () => {
                      await api("/mcp/decide", { id: o.id, approve: false });
                    })
                  }
                >
                  Deny
                </Button>
              </div>
            )}
          </div>
        ))}
      </SettingsSection>
      <SettingsSection title="Connections">
        {data.connections.map((c) => (
          <div
            key={c.id}
            className="settings-surface space-y-3 rounded-xl p-5 text-sm"
          >
            <p className="font-medium">{c.name}</p>
            <p>
              {c.revoked
                ? "Revoked"
                : `Expires ${new Date(Number(c.expires_at)).toLocaleString()}`}
            </p>
            <div className="space-y-1 text-muted-foreground">
              {(() => {
                const p = JSON.parse(c.policy);
                return (
                  <>
                    <p>
                      Projects:{" "}
                      {p.allProjects
                        ? "All current and future projects"
                        : projects
                            .filter((project) =>
                              p.projectIds.includes(project.id),
                            )
                            .map((project) => project.name)
                            .join(", ") || "No available projects"}
                    </p>
                    <p>
                      Machines:{" "}
                      {p.allMachines
                        ? "All current and future machines"
                        : machines
                            .filter((machine) =>
                              p.machineIds.includes(machine.id),
                            )
                            .map((machine) => machine.name)
                            .join(", ") || "No available machines"}
                    </p>
                    <p>
                      Request changes:{" "}
                      {p.manage ? "Allowed, with approval" : "Not allowed"}
                    </p>
                    <p>
                      Request logs:{" "}
                      {p.logs ? "Allowed, with approval" : "Not allowed"}
                    </p>
                    <p>
                      Repository discovery:{" "}
                      {p.repositories ? "Allowed" : "Not allowed"}
                    </p>
                  </>
                );
              })()}
            </div>
            {!c.revoked && Number(c.expires_at) > Date.now() && (
              <Button
                disabled={busy}
                variant="outline"
                onClick={() => editConnection(c)}
              >
                Edit permissions
              </Button>
            )}
            {!c.revoked && (
              <Button
                disabled={busy}
                variant="outline"
                onClick={() =>
                  void run(async () => {
                    await api("/mcp/revoke", { id: c.id });
                  })
                }
              >
                Revoke access
              </Button>
            )}
          </div>
        ))}
      </SettingsSection>
    </SettingsPage>
  );
}
