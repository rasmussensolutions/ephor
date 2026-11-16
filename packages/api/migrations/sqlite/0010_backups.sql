CREATE TABLE ephor_backup_destination (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, config TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', checked_machine TEXT NOT NULL,
 check_password TEXT NOT NULL, created_at BIGINT NOT NULL
);
CREATE TABLE ephor_backup_plan (
 id TEXT PRIMARY KEY, service_id TEXT NOT NULL UNIQUE REFERENCES ephor_service(id),
 destination_id TEXT NOT NULL REFERENCES ephor_backup_destination(id),
 password TEXT NOT NULL, frequency TEXT NOT NULL, hour INTEGER NOT NULL,
 next_run BIGINT NOT NULL, created_at BIGINT NOT NULL
);
CREATE TABLE ephor_backup_job (
 id TEXT PRIMARY KEY, machine_id TEXT NOT NULL REFERENCES ephor_machine(id),
 service_id TEXT, plan_id TEXT REFERENCES ephor_backup_plan(id),
 destination_id TEXT NOT NULL REFERENCES ephor_backup_destination(id),
 action TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL,
 snapshot_id TEXT, error TEXT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
 schedule_key TEXT UNIQUE
);
CREATE UNIQUE INDEX ephor_backup_active_service ON ephor_backup_job(service_id) WHERE status IN ('queued','running');
CREATE UNIQUE INDEX ephor_backup_running_machine ON ephor_backup_job(machine_id) WHERE status='running';
CREATE INDEX ephor_backup_due ON ephor_backup_plan(next_run);
CREATE INDEX ephor_backup_history ON ephor_backup_job(created_at);
CREATE UNIQUE INDEX ephor_backup_active_check ON ephor_backup_job(destination_id) WHERE action='check' AND status IN ('queued','running');
