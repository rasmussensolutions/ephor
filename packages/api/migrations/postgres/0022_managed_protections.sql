CREATE TABLE ephor_protection_agent (
 machine_id TEXT PRIMARY KEY REFERENCES ephor_machine(id), enrollment_hash TEXT, enrollment_expires BIGINT,
 enrollment_claim_hash TEXT, credential_hash TEXT, enabled INTEGER NOT NULL DEFAULT 0,
 last_seen BIGINT, snapshot TEXT, revision TEXT
);
CREATE TABLE ephor_protection_job (
 id TEXT PRIMARY KEY, machine_id TEXT NOT NULL REFERENCES ephor_machine(id), credential_hash TEXT NOT NULL,
 action TEXT NOT NULL, parameters TEXT NOT NULL, revision TEXT NOT NULL, actor TEXT NOT NULL,
 status TEXT NOT NULL, created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, started_at BIGINT, finished_at BIGINT,
 result TEXT
);
CREATE UNIQUE INDEX ephor_protection_active ON ephor_protection_job(machine_id) WHERE status IN ('queued','running');
CREATE INDEX ephor_protection_history ON ephor_protection_job(machine_id,created_at DESC);
