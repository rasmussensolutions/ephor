ALTER TABLE ephor_machine ADD COLUMN updater_key TEXT;
ALTER TABLE ephor_machine ADD COLUMN updater_seen BIGINT;
CREATE TABLE ephor_release (id INTEGER PRIMARY KEY CHECK (id = 1), envelope TEXT, checked_at BIGINT NOT NULL, next_check BIGINT NOT NULL, error TEXT);
INSERT INTO ephor_release (id, checked_at, next_check) VALUES (1, 0, 0);
CREATE TABLE ephor_update (
 id TEXT PRIMARY KEY, machine_id TEXT NOT NULL REFERENCES ephor_machine(id),
 envelope TEXT NOT NULL, version TEXT NOT NULL, build_id TEXT NOT NULL,
 status TEXT NOT NULL, error TEXT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, expires_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX ephor_update_active ON ephor_update(machine_id) WHERE status IN ('queued','downloading','installing');
CREATE INDEX ephor_update_machine ON ephor_update(machine_id, created_at);
