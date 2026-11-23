export const notificationEvents = [
  {
    id: "security_finding",
    label: "Security findings digest",
    description:
      "Grouped high/critical findings, at most one summary every 24 hours. Unchanged findings are not repeated.",
    enabled: true,
  },
  {
    id: "security_coverage_lost",
    label: "Security monitoring unavailable",
    description:
      "A security helper has not reported for 30 minutes; reminders once a day.",
    enabled: true,
  },
  {
    id: "backup_failed",
    label: "Backup failed",
    description:
      "The first failure, then a reminder every 24 hours until a backup succeeds.",
    enabled: true,
  },
  {
    id: "backup_overdue",
    label: "Scheduled backup overdue",
    description:
      "A daily or weekly backup has no recent verified copy, with one hour of grace.",
    enabled: true,
  },
  {
    id: "backup_recovered",
    label: "Backups recovered",
    description: "A verified backup succeeds after a failure or overdue alert.",
    enabled: true,
  },
  {
    id: "backup_succeeded",
    label: "Every successful backup",
    description: "A message for each verified app backup.",
    enabled: false,
  },
  {
    id: "storage_failed",
    label: "Storage connection failed",
    description: "A storage connection test fails.",
    enabled: true,
  },
  {
    id: "restore_finished",
    label: "Restore completed or failed",
    description: "The outcome of each restore operation.",
    enabled: true,
  },
  {
    id: "deployment_failed",
    label: "Deployment failed",
    description: "A deployment operation fails.",
    enabled: true,
  },
  {
    id: "machine_offline",
    label: "Machine offline",
    description:
      "A machine has not reported for five minutes; reminders every 24 hours.",
    enabled: true,
  },
  {
    id: "machine_recovered",
    label: "Machine back online",
    description: "A machine reports again after an offline alert.",
    enabled: true,
  },
] as const;
export type EventType = (typeof notificationEvents)[number]["id"];
export type Preferences = Record<EventType, { inApp: boolean; email: boolean }>;
export function defaultPreferences(): Preferences {
  return Object.fromEntries(
    notificationEvents.map((e) => [
      e.id,
      { inApp: e.enabled, email: e.enabled },
    ]),
  ) as Preferences;
}
export interface NotificationSettings {
  enabled: boolean;
  from: string;
  recipients: string[];
  hasKey: boolean;
  preferences: Preferences;
}
export interface NotificationItem {
  id: string;
  event_type: string;
  title: string;
  body: string;
  href: string;
  severity: string;
  in_app: number;
  read_at: number | null;
  created_at: number;
  email_status: string;
  attempts: number;
  next_attempt: number;
  last_attempt: number | null;
  provider_id: string | null;
  error: string | null;
}
export interface NotificationList {
  nextCursor: string | null;
  items: NotificationItem[];
  unread: number;
  lastRun: number;
}
