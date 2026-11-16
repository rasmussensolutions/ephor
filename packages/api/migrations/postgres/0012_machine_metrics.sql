CREATE TABLE ephor_machine_metric (
  machine_id TEXT NOT NULL REFERENCES ephor_machine(id) ON DELETE CASCADE,
  bucket BIGINT NOT NULL,
  observed_at BIGINT NOT NULL,
  cpu DOUBLE PRECISION NOT NULL,
  memory BIGINT NOT NULL,
  disk DOUBLE PRECISION,
  PRIMARY KEY (machine_id,bucket)
);
CREATE INDEX ephor_machine_metric_retention ON ephor_machine_metric(observed_at);
