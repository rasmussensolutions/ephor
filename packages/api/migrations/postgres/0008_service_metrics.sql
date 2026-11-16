CREATE TABLE ephor_service_metric (
  service_id TEXT NOT NULL REFERENCES ephor_service(id) ON DELETE CASCADE,
  bucket BIGINT NOT NULL,
  observed_at BIGINT NOT NULL,
  cpu DOUBLE PRECISION,
  memory BIGINT NOT NULL,
  rx DOUBLE PRECISION,
  tx DOUBLE PRECISION,
  PRIMARY KEY (service_id,bucket)
);
CREATE INDEX ephor_service_metric_retention ON ephor_service_metric(observed_at);
