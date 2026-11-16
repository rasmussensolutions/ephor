export const activityCategories = [
  "machines",
  "services",
  "backups",
  "integrations",
  "notifications",
  "security",
  "panel",
] as const;
export type ActivityCategory = (typeof activityCategories)[number];
export type ActivityOutcome = "succeeded" | "failed" | "pending" | "unknown";
export interface ActivityItem {
  id: string;
  occurredAt: number;
  action: string;
  category: ActivityCategory;
  outcome: ActivityOutcome;
  actor: {
    id: string | null;
    name: string;
    kind: "user" | "anonymous" | "unknown";
  };
  target: { id: string | null; name: string | null; type: string | null };
  status: number | null;
}
export interface ActivityList {
  items: ActivityItem[];
  nextCursor: string | null;
  users: { id: string; name: string }[];
}
