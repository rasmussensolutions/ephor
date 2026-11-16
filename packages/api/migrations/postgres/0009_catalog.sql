ALTER TABLE ephor_deployment ADD COLUMN protocol INTEGER NOT NULL DEFAULT 2;
ALTER TABLE ephor_deployment ADD COLUMN backup_id TEXT;
