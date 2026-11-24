import { z } from "zod";
import type { AuthEnvironment } from "../auth/config";
import { AuthError, AuthStore, hash, randomToken } from "../auth/store";

export const id = z.string().uuid();
export const policySchema = z
  .object({
    projectIds: z.array(id).max(100).default([]),
    machineIds: z.array(id).max(100).default([]),
    allProjects: z.boolean().default(false),
    allMachines: z.boolean().default(false),
    manage: z.boolean().default(false),
    logs: z.boolean().default(false),
    repositories: z.boolean().default(false),
    // Old grants promised per-action approval; never silently widen them.
    execution: z.enum(["approval", "direct"]).default("approval"),
  })
  .strict();
export type Policy = z.infer<typeof policySchema>;
export interface Connection extends Record<string, unknown> {
  id: string;
  name: string;
  policy: string;
  epoch: number;
  expires_at: number;
  revoked: number;
}

export class AgentAccess {
  constructor(public env: AuthEnvironment) {}
  async connection(connectionId: string) {
    const [row] = await this.env.sql.query<Connection>(
      "SELECT id,name,policy,epoch,expires_at,revoked FROM ephor_mcp_connection WHERE id=$1",
      [connectionId],
    );
    const { state } = await new AuthStore(this.env.sql).read();
    if (
      !row ||
      row.revoked ||
      Number(row.expires_at) <= Date.now() ||
      !state.configured ||
      Number(row.epoch) !== state.epoch
    )
      throw new AuthError("UNAUTHORIZED", 401);
    return { row, policy: policySchema.parse(JSON.parse(row.policy)) };
  }
  async authenticate(request: Request) {
    const match = /^Bearer (ephor_[a-f0-9]{64})$/.exec(
      request.headers.get("authorization") ?? "",
    );
    if (!match?.[1]) throw new AuthError("UNAUTHORIZED", 401);
    const digest = await hash(match[1]);
    const [row] = await this.env.sql.query<{ id: string }>(
      `SELECT id FROM ephor_mcp_connection WHERE token_hash=$1
       UNION SELECT connection_id AS id FROM ephor_mcp_access WHERE token_hash=$1 AND expires_at>$2`,
      [digest, Date.now()],
    );
    if (!row) throw new AuthError("UNAUTHORIZED", 401);
    return this.connection(row.id);
  }
  async issue(name: string, policy: Policy, days: number, bearer = true) {
    const { state } = await new AuthStore(this.env.sql).read();
    if (!state.configured) throw new AuthError("UNAUTHORIZED", 401);
    for (const project of policy.projectIds)
      await this.project(policy, project);
    const connectionId = crypto.randomUUID(),
      token = `ephor_${randomToken()}`;
    await this.env.sql.query(
      "INSERT INTO ephor_mcp_connection(id,name,token_hash,policy,epoch,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        connectionId,
        name,
        bearer ? await hash(token) : null,
        JSON.stringify(policy),
        state.epoch,
        Date.now() + days * 86400000,
        Date.now(),
      ],
    );
    await new AuthStore(this.env.sql).audit(
      "mcp.connection_created",
      connectionId,
    );
    return { id: connectionId, ...(bearer ? { token } : {}) };
  }
  async project(policy: Policy, projectId: string) {
    if (!policy.allProjects && !policy.projectIds.includes(projectId))
      throw new AuthError("MCP_SCOPE_DENIED", 403);
    const [project] = await this.env.sql.query<{ id: string; name: string }>(
      "SELECT id,name FROM ephor_project WHERE id=$1",
      [projectId],
    );
    if (!project) throw new AuthError("MCP_SCOPE_DENIED", 403);
    return project;
  }
  async service(policy: Policy, serviceId: string) {
    const [membership] = await this.env.sql.query<{ project_id: string }>(
      "SELECT project_id FROM ephor_project_service WHERE service_id=$1",
      [serviceId],
    );
    if (!membership) throw new AuthError("MCP_SCOPE_DENIED", 403);
    await this.project(policy, membership.project_id);
  }
  machine(policy: Policy, machineId: string) {
    if (!policy.allMachines && !policy.machineIds.includes(machineId))
      throw new AuthError("MCP_SCOPE_DENIED", 403);
  }
}
