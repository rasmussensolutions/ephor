CREATE TABLE ephor_service_worker (
 machine_id TEXT PRIMARY KEY REFERENCES ephor_machine(id), enrollment_hash TEXT, enrollment_expires BIGINT,
 credential_hash TEXT, last_seen BIGINT NOT NULL DEFAULT 0, version TEXT
);
CREATE TABLE ephor_service (
 id TEXT PRIMARY KEY, machine_id TEXT NOT NULL REFERENCES ephor_machine(id), name TEXT NOT NULL,
 domain TEXT UNIQUE, config TEXT NOT NULL, source TEXT NOT NULL, created_at BIGINT NOT NULL,
 runtime TEXT, runtime_at BIGINT, auto_deploy INTEGER NOT NULL DEFAULT 0,
 last_run BIGINT NOT NULL DEFAULT 0, current_deployment TEXT
);
CREATE TABLE ephor_deployment (
 id TEXT PRIMARY KEY, service_id TEXT NOT NULL REFERENCES ephor_service(id), machine_id TEXT NOT NULL REFERENCES ephor_machine(id),
 action TEXT NOT NULL, spec TEXT NOT NULL, status TEXT NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
 source_ref TEXT, delivery TEXT UNIQUE, digest TEXT, error TEXT
);
CREATE UNIQUE INDEX ephor_deployment_active ON ephor_deployment(service_id) WHERE status IN ('queued','running');
CREATE INDEX ephor_deployment_queue ON ephor_deployment(machine_id, status, created_at);
CREATE INDEX ephor_deployment_history ON ephor_deployment(service_id, created_at);
