import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ConnectionPermissions } from "@/components/connection-permissions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, reauthenticate, type SessionInfo } from "@/lib/auth";
import { authorizationId, connectionName, readPolicy } from "@/lib/mcp";

type Resource = { id: string; name: string };
interface ConsentData {
  request: {
    id: string;
    clientName: string;
    redirectUri: string;
    expiresAt: number;
  };
  projects: Resource[];
  machines: Resource[];
  session: SessionInfo;
}
export const Route = createFileRoute("/connect/ai")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Connect an AI client — Ephor" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  validateSearch: (search): { authorization?: string } => ({
    authorization: authorizationId(search.authorization),
  }),
  loaderDeps: ({ search }) => ({ authorization: search.authorization }),
  loader: async ({ deps }) => {
    if (!deps.authorization)
      throw new Error(
        "This connection link is invalid. Start connecting again from your AI client.",
      );
    const [request, projects, machines, session] = await Promise.all([
      api<{
        id: string;
        clientName: string;
        redirectUri: string;
        expiresAt: number;
      }>(`/mcp/authorizations/${deps.authorization}`),
      api<{ projects: Resource[] }>("/projects"),
      api<{ machines: Resource[] }>("/machines"),
      api<SessionInfo>("/session"),
    ]);
    return {
      request,
      projects: projects.projects,
      machines: machines.machines,
      session,
    };
  },
  errorComponent: ({ error }) => (
    <main id="main" className="mx-auto max-w-lg space-y-4 px-6 py-20">
      <h1 className="text-2xl font-semibold">Unable to connect</h1>
      <p role="alert">
        {error instanceof Error
          ? error.message
          : "This connection request is unavailable."}
      </p>
      <p>Return to your AI client and start a new connection.</p>
    </main>
  ),
  component: Consent,
});

function Consent() {
  const data = Route.useLoaderData();
  return <ConsentForm key={data.request.id} {...data} />;
}

function ConsentForm({ request, projects, machines, session }: ConsentData) {
  const [name, setName] = useState(() => connectionName(request.clientName));
  const [policy, setPolicy] = useState(() =>
    readPolicy(
      projects.map((p) => p.id),
      machines.map((m) => m.id),
    ),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const missingProjectAccess =
    policy.manage && !policy.allProjects && policy.projectIds.length === 0;
  const [expired, setExpired] = useState(() => Date.now() >= request.expiresAt);
  useEffect(() => {
    const timer = window.setTimeout(
      () => setExpired(true),
      Math.max(0, request.expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [request.expiresAt]);
  async function connect(approve: boolean) {
    if (busy || (approve && missingProjectAccess)) return;
    setBusy(true);
    setError("");
    try {
      if (Date.now() >= new Date(session.session.freshUntil).getTime())
        await reauthenticate();
      const result = await api<{ redirect: string }>("/mcp/authorize", {
        id: request.id,
        approve,
        name: name.trim() || connectionName(request.clientName),
        policy,
        days: 30,
      });
      window.location.assign(result.redirect);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not connect. Please try again.",
      );
      setBusy(false);
    }
  }
  return (
    <main id="main" className="mx-auto min-h-svh max-w-2xl px-5 py-8 sm:py-12">
      <div className="mb-6 flex items-center gap-2 text-lg font-medium">
        <img src="/logo.png" alt="" className="size-6 dark:invert" />
        Ephor
      </div>
      <section className="rounded-xl border bg-card text-card-foreground">
        <header className="space-y-3 border-b p-5 sm:p-7">
          <h1 className="break-words text-2xl font-semibold">
            {connectionName(request.clientName)} wants to connect
          </h1>
          <p className="text-sm leading-6 text-muted-foreground">
            Review what this client can do in Ephor. Connect once, then work
            from chat. Access expires after 30 days and can be revoked at any
            time.
          </p>
          <p className="break-all text-sm">
            Return to: <strong>{new URL(request.redirectUri).origin}</strong>
          </p>
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">Connection details</summary>
            <p className="mt-2 break-all">{request.redirectUri}</p>
            <p className="mt-2">
              The client supplies its name. Only connect a client you intended
              to use.
            </p>
          </details>
        </header>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void connect(true);
          }}
        >
          <div className="space-y-5 p-5 sm:p-7">
            <div className="space-y-2">
              <label htmlFor="connection-name" className="text-sm font-medium">
                Connection name
              </label>
              <Input
                id="connection-name"
                autoComplete="off"
                value={name}
                maxLength={80}
                required
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <fieldset
              disabled={busy || expired}
              className="grid gap-2 sm:grid-cols-2"
            >
              <legend className="mb-2 text-sm font-medium">Access level</legend>
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm">
                <input
                  type="radio"
                  name="access-level"
                  className="mt-1"
                  checked={!policy.manage}
                  onChange={() => setPolicy({ ...policy, manage: false })}
                />
                <span>
                  <strong>Read only</strong>
                  <span className="block text-muted-foreground">
                    View projects, services and metrics.
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm">
                <input
                  type="radio"
                  name="access-level"
                  className="mt-1"
                  checked={policy.manage}
                  onChange={() =>
                    setPolicy({ ...policy, manage: true, repositories: true })
                  }
                />
                <span>
                  <strong>Manage and deploy</strong>
                  <span className="block text-muted-foreground">
                    Change infrastructure within the permissions below.
                  </span>
                </span>
              </label>
            </fieldset>
            <ConnectionPermissions
              policy={policy}
              onChange={setPolicy}
              projects={projects}
              machines={machines}
              disabled={busy || expired}
            />
            {missingProjectAccess && (
              <p role="alert" className="text-sm text-destructive">
                Select a project to manage, or enable access to all current and
                future projects so this client can create your first project.
              </p>
            )}
            {expired && (
              <p role="alert" className="text-sm text-destructive">
                This request expired. Start connecting again from your AI
                client.
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <footer className="sticky bottom-0 flex items-center justify-end gap-3 rounded-b-xl border-t bg-card p-5 sm:px-7">
            <Button
              type="button"
              variant="outline"
              disabled={busy || expired}
              onClick={() => void connect(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={busy || expired || !name.trim() || missingProjectAccess}
            >
              {busy ? "Connecting…" : "Connect"}
            </Button>
          </footer>
        </form>
      </section>
    </main>
  );
}
