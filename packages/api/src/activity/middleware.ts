import type { MiddlewareHandler } from "hono";
import { type AuthEnvironment, createAuth, requireOwner } from "../auth/config";
import { AuthError, AuthStore } from "../auth/store";
import { Activity } from "./store";
import { type ActivityItem, activityCategories } from "./types";

type Body = Record<string, unknown>;
type Description = {
  action: string;
  type?: string;
  id?: unknown;
  created?: boolean;
};
const identifier = (value: unknown) =>
  typeof value === "string" && value.length <= 256 && !/\p{Cc}/u.test(value)
    ? value
    : null;
const object = (value: unknown): Body =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Body)
    : {};

// Explicit labels and identifiers only. Never persist request/response bodies,
// headers, query strings, variable values, recovery codes, or credentials.
export function describeActivity(path: string, body: Body): Description {
  const project = /^\/api\/projects\/([^/]+)\/(rename|add|remove|delete)$/.exec(
    path,
  );
  if (project)
    return {
      action:
        (
          {
            rename: "Rename project",
            add: "Add service to project",
            remove: "Remove service from project",
            delete: "Delete project",
          } as Record<string, string>
        )[project[2] ?? ""] ?? "Update project",
      type: "project",
      id: project[1],
    };
  const exact: Record<string, Description> = {
    "/api/projects/create": {
      action: "Create project",
      type: "project",
      created: true,
    },
    "/api/setup/start": { action: "Start panel setup" },
    "/api/recovery/start": { action: "Start account recovery" },
    "/api/auth/passkey/verify-registration": { action: "Register passkey" },
    "/api/auth/passkey/verify-authentication": { action: "Sign in" },
    "/api/security/reauth/verify": { action: "Verify identity" },
    "/api/mcp/delete": {
      action: "Delete MCP connection",
      type: "mcp",
      id: body.id,
    },
    "/api/mcp/revoke": {
      action: "Revoke MCP connection",
      type: "mcp",
      id: body.id,
    },
    "/api/auth/sign-out": { action: "Sign out" },
    "/api/machines/enrollments": {
      action: body.id
        ? "Regenerate machine enrollment"
        : "Create machine enrollment",
      type: "machine",
      id: body.id,
      created: true,
    },
    "/api/machines/enrollments/cancel": {
      action: "Cancel machine enrollment",
      type: "machine",
      id: body.id,
    },
    "/api/machines/revoke": {
      action: "Revoke machine",
      type: "machine",
      id: body.id,
    },
    "/api/machines/rename": {
      action: "Rename machine",
      type: "machine",
      id: body.id,
    },
    "/api/machines/provider": {
      action: "Change machine provider",
      type: "machine",
      id: body.id,
    },
    "/api/machines/updates": {
      action: "Queue machine update",
      type: "machine",
      id: body.id,
    },
    "/api/machines/updates/check": { action: "Check for machine updates" },
    "/api/services/create": {
      action: "Create service",
      type: "service",
      created: true,
    },
    "/api/services/map-positions": {
      action: "Arrange services on map",
      type: "service",
    },
    "/api/services/catalog/deploy": {
      action: "Deploy catalog app",
      type: "service",
      created: true,
    },
    "/api/services/worker": {
      action: "Create deployment worker enrollment",
      type: "machine",
      id: body.machineId,
    },
    "/api/services/cancel": {
      action: "Cancel deployment",
      type: "deployment",
      id: body.id,
    },
    "/api/services/builds/cancel": {
      action: "Cancel build",
      type: "build",
      id: body.id,
    },
    "/api/backups/destinations": {
      action: "Create backup destination",
      type: "destination",
      created: true,
    },
    "/api/backups/plans": {
      action: "Configure backup schedule",
      type: "service",
      id: body.serviceId,
    },
    "/api/backups/restore": {
      action: "Restore backup",
      type: "service",
      created: true,
    },
    "/api/integrations/github/start": { action: "Start GitHub connection" },
    "/api/integrations/github/finish": { action: "Connect GitHub" },
    "/api/integrations/github/disconnect": { action: "Disconnect GitHub" },
    "/api/integrations/build-registry": { action: "Update build registry" },
    "/api/integrations/ai/connect": { action: "Verify AI connection" },
    "/api/integrations/ai/disconnect": { action: "Disconnect AI provider" },
    "/api/notifications/read": {
      action:
        body.id === "all"
          ? "Mark all notifications read"
          : "Mark notification read",
      type: "notification",
      id: body.id,
    },
    "/api/notifications/settings": { action: "Update notification settings" },
    "/api/notifications/test": { action: "Send test notification" },
    "/api/security/recovery-codes": { action: "Regenerate recovery codes" },
    "/api/security/collector": {
      action: "Enroll security collector",
      type: "machine",
      id: body.machineId,
    },
    "/api/security/collector/revoke": {
      action: "Revoke security collector",
      type: "machine",
      id: body.machineId,
    },
    "/api/security/scan": {
      action: "Request security scan",
      type: body.serviceId ? "service" : "machine",
      id: body.serviceId || body.machineId,
    },
    "/api/security/settings": { action: "Change security retention" },
    "/api/security/passkeys/remove": {
      action: "Remove passkey",
      type: "passkey",
      id: body.id,
    },
    "/api/security/sessions/revoke": {
      action: body.id === "others" ? "Revoke other sessions" : "Revoke session",
      type: "session",
      id: body.id,
    },
  };
  if (exact[path]) return exact[path];
  const service = /^\/api\/services\/([^/]+)\/(.+)$/.exec(path);
  if (service) {
    let action = (
      {
        configure: "Configure service",
        presentation: "Update service appearance",
        variables: "Update service variables",
        "variables/reveal": "Reveal service variable",
        "catalog-access": "Access app credentials",
        dns: "Check service DNS and HTTPS",
        workflow: "Download deployment workflow",
        "diagnose-build": "Diagnose failed build with AI",
      } as Record<string, string>
    )[service[2] ?? ""];
    if (service[2] === "action") {
      const actions: Record<string, string> = {
        deploy: "Deploy service",
        stop: "Stop service",
        backup: "Create service recovery point",
        restore: "Restore service recovery point",
        "delete-backup": "Delete service recovery point",
        rollback: "Roll back service",
        remove: "Remove service",
        destroy: "Destroy service",
      };
      action = actions[String(body.action)] ?? "Run service action";
    }
    if (service[2]?.match(/^components\/[^/]+\/variables\/reveal$/))
      action = "Reveal component variable";
    if (service[2] === "presentation") {
      action = body.position
        ? "Move service on map"
        : body.component
          ? "Rename service component"
          : body.name
            ? "Rename service"
            : "Update service group";
    }
    if (service[2] === "catalog-access")
      action =
        body.publish === true
          ? "Publish app access"
          : body.protect === true
            ? "Protect app access"
            : "Reveal app credentials";
    return {
      action: action ?? "Update service",
      type: "service",
      id: service[1],
    };
  }
  const backup =
    /^\/api\/backups\/(destinations|plans)\/([^/]+)\/(check|credentials|run|recovery)$/.exec(
      path,
    );
  if (backup)
    return {
      action:
        (
          {
            check: "Check backup destination",
            credentials: "Update backup credentials",
            run: "Run backup",
            recovery: "Reveal backup recovery credentials",
          } as Record<string, string>
        )[backup[3] ?? ""] ?? "Update backup",
      type: backup[1] === "plans" ? "plan" : "destination",
      id: backup[2],
    };
  // The common boundary also covers future mutations before a label is added.
  return { action: "Panel action" };
}

async function targetSnapshot(
  env: AuthEnvironment,
  description: Description,
): Promise<ActivityItem["target"]> {
  const target = {
    id: identifier(description.id),
    name: null as string | null,
    type: description.type ?? null,
  };
  if (!target.id) return target;
  const queries: Record<string, string> = {
    project: "SELECT name FROM ephor_project WHERE id=$1",
    machine: "SELECT name FROM ephor_machine WHERE id=$1",
    service: "SELECT name FROM ephor_service WHERE id=$1",
    destination: "SELECT name FROM ephor_backup_destination WHERE id=$1",
    plan: "SELECT s.name FROM ephor_backup_plan p JOIN ephor_service s ON s.id=p.service_id WHERE p.id=$1",
    deployment:
      "SELECT s.name FROM ephor_deployment d JOIN ephor_service s ON s.id=d.service_id WHERE d.id=$1",
    build:
      "SELECT s.name FROM ephor_build b JOIN ephor_service s ON s.id=b.service_id WHERE b.id=$1",
    passkey: "SELECT name FROM passkey WHERE id=$1",
  };
  const query = queries[target.type ?? ""];
  if (query)
    target.name =
      (await env.sql.query<{ name: string }>(query, [target.id]))[0]?.name ??
      null;
  return target;
}

export function activityMiddleware(env: AuthEnvironment): MiddlewareHandler {
  const activity = new Activity(env.sql),
    store = new AuthStore(env.sql);
  return async (c, next) => {
    const path = c.req.path;
    if (
      path === "/api/panel-updater/poll" ||
      path === "/api/security/reauth/options" ||
      path === "/api/panel/check" ||
      path.startsWith("/api/agent/") ||
      path.startsWith("/api/deploy/") ||
      path === "/api/integrations/github/webhook"
    )
      return next();
    const explicitRead =
      c.req.method === "GET" &&
      /^\/api\/services\/[^/]+\/(dns|workflow)$/.test(path);
    if (
      !["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method) &&
      !explicitRead
    )
      return next();
    let actor: ActivityItem["actor"] = {
      id: null,
      name: "Unauthenticated",
      kind: "anonymous",
    };
    try {
      const session = await requireOwner(
        createAuth(env, c.req.raw.headers),
        store,
        c.req.raw.headers,
      );
      actor = { id: session.user.id, name: session.user.name, kind: "user" };
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
    }
    let body: Body = {};
    if (!explicitRead) {
      try {
        body = object(await c.req.raw.clone().json());
      } catch {
        /* The route will reject malformed JSON. */
      }
    }
    const description = describeActivity(path, body);
    const segment = path.split("/")[2] ?? "";
    const category = ["auth", "setup", "recovery"].includes(segment)
      ? "security"
      : activityCategories.includes(segment as ActivityItem["category"])
        ? (segment as ActivityItem["category"])
        : "panel";
    let target = await targetSnapshot(env, description);
    // Persist before execution so interrupted requests remain visible as unconfirmed.
    const id = await activity.start({
      action: description.action,
      category,
      actor,
      target,
    });
    await next();
    if (
      c.res.ok &&
      (description.created || path.startsWith("/api/auth/passkey/verify-"))
    ) {
      const result = object(
        await c.res
          .clone()
          .json()
          .catch(() => null),
      );
      if (description.created && !target.id) {
        target = await targetSnapshot(env, {
          ...description,
          id: path === "/api/backups/restore" ? result.serviceId : result.id,
        });
      }
      // Identity comes only from the verified authentication response, never client input.
      if (path.startsWith("/api/auth/passkey/verify-")) {
        const user = object(result.user);
        if (typeof user.id === "string" && typeof user.name === "string")
          actor = { id: user.id, name: user.name, kind: "user" };
      }
    }
    await activity.finish(id, c.res.status, actor, target);
  };
}
