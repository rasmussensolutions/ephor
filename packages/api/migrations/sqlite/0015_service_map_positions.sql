CREATE TABLE ephor_service_map_position (
  service_id TEXT NOT NULL REFERENCES ephor_service(id) ON DELETE CASCADE,
  component_id TEXT NOT NULL DEFAULT '',
  x REAL NOT NULL CHECK (x >= 0 AND x <= 20000),
  y REAL NOT NULL CHECK (y >= 0 AND y <= 20000),
  PRIMARY KEY (service_id, component_id)
);
