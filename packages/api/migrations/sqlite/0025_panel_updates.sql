CREATE TABLE ephor_panel_github_installation (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL
);
CREATE TABLE ephor_panel_update (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload TEXT NOT NULL DEFAULT '{}',
  lease TEXT,
  lease_until BIGINT NOT NULL DEFAULT 0
);
INSERT INTO ephor_panel_update (id) VALUES (1);
