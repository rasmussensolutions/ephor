CREATE TABLE ephor_security_deployment (
 id INTEGER PRIMARY KEY CHECK(id=1), provider TEXT NOT NULL DEFAULT '',
 ingress TEXT NOT NULL DEFAULT 'unknown', frontend TEXT NOT NULL DEFAULT 'unknown',
 machine_id TEXT, updated_at BIGINT, revision INTEGER NOT NULL DEFAULT 0
);
INSERT INTO ephor_security_deployment(id) VALUES(1);
