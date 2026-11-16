CREATE TABLE ephor_integration (id TEXT PRIMARY KEY, config TEXT NOT NULL);
CREATE TABLE ephor_github_state (digest TEXT PRIMARY KEY, kind TEXT NOT NULL, epoch BIGINT NOT NULL, expires BIGINT NOT NULL);
CREATE TABLE ephor_github_installation (id TEXT PRIMARY KEY, account TEXT NOT NULL);
CREATE TABLE ephor_service_domain (hostname TEXT PRIMARY KEY, service_id TEXT NOT NULL REFERENCES ephor_service(id), redirect INTEGER NOT NULL DEFAULT 0);
INSERT INTO ephor_service_domain (hostname,service_id) SELECT domain,id FROM ephor_service WHERE domain IS NOT NULL;
ALTER TABLE ephor_deployment ADD COLUMN domains TEXT;
CREATE TABLE ephor_build (
 id TEXT PRIMARY KEY, service_id TEXT NOT NULL REFERENCES ephor_service(id), machine_id TEXT NOT NULL REFERENCES ephor_machine(id),
 source TEXT NOT NULL, config TEXT NOT NULL, domains TEXT NOT NULL, status TEXT NOT NULL,
 created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, delivery TEXT UNIQUE, automatic INTEGER NOT NULL DEFAULT 0,
 digest TEXT, error TEXT, logs TEXT NOT NULL DEFAULT '', phase TEXT NOT NULL DEFAULT 'queued'
);
CREATE UNIQUE INDEX ephor_build_running ON ephor_build(machine_id) WHERE status='running';
CREATE INDEX ephor_build_queue ON ephor_build(machine_id,status,created_at);
CREATE INDEX ephor_build_service ON ephor_build(service_id,created_at);
ALTER TABLE ephor_service ADD COLUMN domains TEXT;
