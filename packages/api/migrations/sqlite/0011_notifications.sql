CREATE TABLE ephor_notification_settings (
 id INTEGER PRIMARY KEY CHECK (id=1), config TEXT NOT NULL, preferences TEXT NOT NULL,
 started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE ephor_notification_runtime (
 id INTEGER PRIMARY KEY CHECK (id=1), lease_owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
 last_run INTEGER NOT NULL DEFAULT 0
);
INSERT INTO ephor_notification_runtime (id) VALUES (1);
CREATE TABLE ephor_notification (
 id TEXT PRIMARY KEY, event_key TEXT NOT NULL UNIQUE, event_type TEXT NOT NULL,
 title TEXT NOT NULL, body TEXT NOT NULL, href TEXT NOT NULL, severity TEXT NOT NULL,
 in_app INTEGER NOT NULL, read_at INTEGER, created_at INTEGER NOT NULL,
 email_status TEXT NOT NULL, email_config TEXT, attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt INTEGER NOT NULL DEFAULT 0, first_attempt INTEGER, last_attempt INTEGER,
 lease_owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0, provider_id TEXT, error TEXT
);
CREATE INDEX ephor_notification_history ON ephor_notification(created_at);
CREATE INDEX ephor_notification_due ON ephor_notification(email_status,next_attempt);
CREATE TABLE ephor_notification_source (id TEXT PRIMARY KEY, processed_at INTEGER NOT NULL);
CREATE TABLE ephor_notification_condition (
 id TEXT PRIMARY KEY, active INTEGER NOT NULL, episode TEXT NOT NULL, notified_at INTEGER NOT NULL
);
