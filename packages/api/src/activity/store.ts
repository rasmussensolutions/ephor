import { AuthError, type Sql } from "../auth/store";
import {
  type ActivityItem,
  type ActivityList,
  activityCategories,
} from "./types";

type Row = Record<string, unknown> & {
  id: string;
  occurred_at: number | string;
  action: string;
  category: ActivityItem["category"];
  outcome: ActivityItem["outcome"];
  actor_id: string | null;
  actor_name: string;
  actor_kind: ActivityItem["actor"]["kind"];
  target_id: string | null;
  target_name: string | null;
  target_type: string | null;
  status: number | null;
};
export class Activity {
  constructor(private sql: Sql) {}
  async start(
    item: Omit<ActivityItem, "id" | "occurredAt" | "status" | "outcome">,
  ) {
    const id = crypto.randomUUID();
    await this.sql.query(
      `INSERT INTO ephor_activity (id, occurred_at, action, category, outcome,
       actor_id, actor_name, actor_kind, target_id, target_name, target_type)
       VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9,$10)`,
      [
        id,
        Date.now(),
        item.action,
        item.category,
        item.actor.id,
        item.actor.name,
        item.actor.kind,
        item.target.id,
        item.target.name,
        item.target.type,
      ],
    );
    return id;
  }
  async finish(
    id: string,
    status: number,
    actor: ActivityItem["actor"],
    target: ActivityItem["target"],
  ) {
    await this.sql.query(
      `UPDATE ephor_activity SET outcome=$1, status=$2, actor_id=$3, actor_name=$4,
       actor_kind=$5, target_id=$6, target_name=$7, target_type=$8 WHERE id=$9`,
      [
        status < 400 ? "succeeded" : "failed",
        status,
        actor.id,
        actor.name,
        actor.kind,
        target.id,
        target.name,
        target.type,
        id,
      ],
    );
  }
  async list(params: URLSearchParams): Promise<ActivityList> {
    const values: unknown[] = [],
      clauses: string[] = [];
    const bind = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    const category = params.get("category"),
      outcome = params.get("outcome"),
      user = params.get("user");
    if (category) {
      if (!activityCategories.includes(category as ActivityItem["category"]))
        throw new AuthError("INVALID_ACTIVITY_FILTER");
      clauses.push(`category=${bind(category)}`);
    }
    if (outcome) {
      if (!["succeeded", "failed", "pending", "unknown"].includes(outcome))
        throw new AuthError("INVALID_ACTIVITY_FILTER");
      clauses.push(`outcome=${bind(outcome)}`);
    }
    if (user) {
      if (user.length > 256) throw new AuthError("INVALID_ACTIVITY_FILTER");
      clauses.push(`actor_id=${bind(user)}`);
    }
    const search = (params.get("q") ?? "").trim();
    if (search.length > 200) throw new AuthError("INVALID_ACTIVITY_FILTER");
    if (search) {
      const term = bind(`%${search.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`);
      clauses.push(
        `(LOWER(action) LIKE ${term} ESCAPE '\\' OR LOWER(actor_name) LIKE ${term} ESCAPE '\\' OR LOWER(COALESCE(target_name, '')) LIKE ${term} ESCAPE '\\' OR LOWER(COALESCE(target_id, '')) LIKE ${term} ESCAPE '\\')`,
      );
    }
    for (const [key, op] of [
      ["from", ">="],
      ["to", "<"],
    ] as const) {
      const raw = params.get(key);
      if (raw) {
        const value = Number(raw);
        if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value))
          throw new AuthError("INVALID_ACTIVITY_FILTER");
        clauses.push(`occurred_at ${op} ${bind(value)}`);
      }
    }
    const before = params.get("before");
    if (before) {
      const match = /^(\d+):([a-f0-9-]{36})$/.exec(before);
      if (!match || !Number.isSafeInteger(Number(match[1])))
        throw new AuthError("INVALID_ACTIVITY_CURSOR");
      const time = bind(Number(match[1])),
        id = bind(match[2]);
      clauses.push(
        `(occurred_at < ${time} OR (occurred_at = ${time} AND id < ${id}))`,
      );
    }
    const rows = await this.sql.query<Row>(
      `SELECT * FROM ephor_activity ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY occurred_at DESC, id DESC LIMIT 51`,
      values,
    );
    const items = rows.slice(0, 50).map(
      (r): ActivityItem => ({
        id: r.id,
        occurredAt: Number(r.occurred_at),
        action: r.action,
        category: r.category,
        outcome: r.outcome,
        actor: { id: r.actor_id, name: r.actor_name, kind: r.actor_kind },
        target: { id: r.target_id, name: r.target_name, type: r.target_type },
        status: r.status,
      }),
    );
    const last = items.at(-1);
    const users = await this.sql.query<{ id: string; name: string }>(
      `SELECT a.actor_id AS id, a.actor_name AS name FROM ephor_activity a
       WHERE a.actor_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM ephor_activity b WHERE b.actor_id=a.actor_id
         AND (b.occurred_at > a.occurred_at OR (b.occurred_at=a.occurred_at AND b.id>a.id))
       ) ORDER BY a.actor_name, a.actor_id`,
    );
    return {
      items,
      nextCursor:
        rows.length > 50 && last ? `${last.occurredAt}:${last.id}` : null,
      users,
    };
  }
}
