-- Actor and resource snapshots intentionally survive renames and deletion.
CREATE TABLE ephor_activity (
 id TEXT PRIMARY KEY, occurred_at BIGINT NOT NULL,
 action TEXT NOT NULL, category TEXT NOT NULL,
 outcome TEXT NOT NULL, actor_id TEXT, actor_name TEXT NOT NULL,
 actor_kind TEXT NOT NULL, target_id TEXT, target_name TEXT, target_type TEXT,
 status INTEGER
);
CREATE INDEX ephor_activity_time ON ephor_activity(occurred_at DESC, id DESC);
CREATE INDEX ephor_activity_actor ON ephor_activity(actor_id, occurred_at DESC, id DESC);
CREATE INDEX ephor_activity_category ON ephor_activity(category, occurred_at DESC, id DESC);
-- Older audit entries did not record an actor or a reliable outcome.
INSERT INTO ephor_activity
 (id, occurred_at, action, category, outcome, actor_name, actor_kind, target_id)
 SELECT id, occurred_at, event,
 CASE WHEN event LIKE 'machine.%' THEN 'machines'
      WHEN event LIKE 'service.%' THEN 'services' ELSE 'security' END,
 'unknown', 'Not recorded', 'unknown', subject FROM ephor_auth_audit;
-- Classify the legacy event families without inventing missing user identity.
UPDATE ephor_activity SET category = CASE
 WHEN action LIKE 'backup.%' THEN 'backups'
 WHEN action LIKE 'notification.%' THEN 'notifications'
 WHEN action LIKE 'github.%' OR action LIKE 'build.%' THEN 'integrations'
 ELSE category END,
 target_type = CASE
 WHEN action LIKE 'machine.%' OR action = 'service.worker_enrollment_issued' THEN 'machine'
 WHEN action = 'service.build_cancelled' THEN 'build'
 WHEN action LIKE 'service.%' THEN 'service'
 ELSE target_type END
 WHERE outcome = 'unknown' AND actor_kind = 'unknown';
