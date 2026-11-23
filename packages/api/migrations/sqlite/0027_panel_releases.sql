CREATE TABLE ephor_panel_release (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload TEXT,
  lease TEXT,
  lease_until BIGINT NOT NULL DEFAULT 0
);
INSERT INTO ephor_panel_release (id) VALUES (1);
