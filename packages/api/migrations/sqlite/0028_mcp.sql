CREATE TABLE ephor_mcp_connection (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE,
 policy TEXT NOT NULL, epoch INTEGER NOT NULL, expires_at BIGINT NOT NULL,
 revoked INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL
);
CREATE TABLE ephor_mcp_operation (
 id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES ephor_mcp_connection(id),
 request_key TEXT NOT NULL, tool TEXT NOT NULL, payload TEXT NOT NULL,
 status TEXT NOT NULL, result TEXT, created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL,
 UNIQUE(connection_id, request_key)
);
CREATE INDEX ephor_mcp_operation_pending ON ephor_mcp_operation(status, created_at);
CREATE TABLE ephor_mcp_client (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, redirects TEXT NOT NULL, created_at BIGINT NOT NULL
);
CREATE TABLE ephor_mcp_oauth (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES ephor_mcp_client(id),
 request TEXT NOT NULL, code_hash TEXT UNIQUE, connection_id TEXT REFERENCES ephor_mcp_connection(id),
 status TEXT NOT NULL, expires_at BIGINT NOT NULL
);
CREATE TABLE ephor_mcp_access (
 token_hash TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES ephor_mcp_connection(id),
 expires_at BIGINT NOT NULL
);
CREATE TABLE ephor_mcp_refresh (
 token_hash TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES ephor_mcp_connection(id),
 client_id TEXT NOT NULL REFERENCES ephor_mcp_client(id), expires_at BIGINT NOT NULL, used INTEGER NOT NULL DEFAULT 0
);
