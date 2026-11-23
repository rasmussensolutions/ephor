CREATE TABLE ephor_security_agent (
 machine_id TEXT PRIMARY KEY REFERENCES ephor_machine(id), enrollment_hash TEXT, enrollment_expires BIGINT,
 credential_hash TEXT, enrollment_claim_hash TEXT, last_seen BIGINT, version TEXT, enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE ephor_security_scan (
 id TEXT PRIMARY KEY, machine_id TEXT NOT NULL REFERENCES ephor_machine(id), service_id TEXT,
 target TEXT NOT NULL, revision TEXT, status TEXT NOT NULL, created_at BIGINT NOT NULL,
 started_at BIGINT, finished_at BIGINT, lease_until BIGINT, result TEXT, error TEXT, force_scan INTEGER NOT NULL DEFAULT 0,
 report_hash TEXT, progress INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX ephor_security_scan_active ON ephor_security_scan(target) WHERE status IN ('queued','running');
CREATE INDEX ephor_security_scan_history ON ephor_security_scan(target,created_at DESC);
CREATE INDEX ephor_security_scan_queue ON ephor_security_scan(machine_id,status,created_at);
CREATE TABLE ephor_security_finding (
 id TEXT PRIMARY KEY, machine_id TEXT NOT NULL REFERENCES ephor_machine(id), service_id TEXT,
 target TEXT NOT NULL, rule TEXT NOT NULL, category TEXT NOT NULL, component TEXT NOT NULL,
 severity TEXT NOT NULL, title TEXT NOT NULL, evidence TEXT NOT NULL, remediation TEXT NOT NULL,
 detail TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', reason TEXT, accepted_until BIGINT,
 first_seen BIGINT NOT NULL, last_seen BIGINT NOT NULL, resolved_at BIGINT, scan_id TEXT NOT NULL, opened_scan TEXT NOT NULL
);
CREATE INDEX ephor_security_finding_target ON ephor_security_finding(target,status);
CREATE INDEX ephor_security_finding_status ON ephor_security_finding(status,severity,last_seen DESC);
CREATE TABLE ephor_security_event (
 id TEXT PRIMARY KEY, machine_id TEXT, service_id TEXT, finding_id TEXT,
 occurred_at BIGINT NOT NULL, received_at BIGINT NOT NULL, kind TEXT NOT NULL,
 actor TEXT NOT NULL, action TEXT NOT NULL, outcome TEXT NOT NULL, detail TEXT NOT NULL
);
CREATE INDEX ephor_security_event_time ON ephor_security_event(occurred_at DESC,id DESC);
CREATE INDEX ephor_security_event_machine ON ephor_security_event(machine_id,occurred_at DESC);
CREATE TABLE ephor_security_settings (
 id INTEGER PRIMARY KEY CHECK(id=1), retention_days INTEGER NOT NULL DEFAULT 90, maintenance_at BIGINT NOT NULL DEFAULT 0
);
INSERT INTO ephor_security_settings (id) VALUES (1);
