CREATE TABLE ephor_project (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE ephor_project_service (
  service_id TEXT PRIMARY KEY REFERENCES ephor_service(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES ephor_project(id) ON DELETE CASCADE
);
CREATE INDEX ephor_project_service_project ON ephor_project_service(project_id);
