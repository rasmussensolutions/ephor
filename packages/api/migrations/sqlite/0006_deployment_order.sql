ALTER TABLE ephor_deployment ADD COLUMN run_number BIGINT NOT NULL DEFAULT 0;
CREATE INDEX ephor_deployment_run ON ephor_deployment(service_id, run_number);
