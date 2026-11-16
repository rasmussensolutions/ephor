CREATE TABLE ephor_component_metric (
  service_id TEXT NOT NULL REFERENCES ephor_service(id) ON DELETE CASCADE,
  component TEXT NOT NULL,
  bucket BIGINT NOT NULL,
  observed_at BIGINT NOT NULL,
  cpu DOUBLE PRECISION,
  memory BIGINT NOT NULL,
  rx DOUBLE PRECISION,
  tx DOUBLE PRECISION,
  PRIMARY KEY (service_id,component,bucket)
);
CREATE INDEX ephor_component_metric_retention ON ephor_component_metric(observed_at);
