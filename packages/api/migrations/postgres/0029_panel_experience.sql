CREATE TABLE ephor_session_verification (
 session_id TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
 challenge TEXT NOT NULL, expires_at BIGINT NOT NULL, verified_at BIGINT NOT NULL
);
ALTER TABLE ephor_panel_release ADD COLUMN next_check BIGINT NOT NULL DEFAULT 0;
-- Preserve a named activity history independently of deletable connection records.
INSERT INTO ephor_activity (id,occurred_at,action,category,outcome,actor_id,actor_name,actor_kind,target_id,target_type)
SELECT o.id,o.created_at,UPPER(SUBSTR(REPLACE(o.tool,'_',' '),1,1)) || SUBSTR(REPLACE(o.tool,'_',' '),2),
 CASE WHEN o.tool LIKE '%machine%' THEN 'machines' ELSE 'services' END,
 CASE WHEN o.status='completed' THEN 'succeeded' WHEN o.status IN ('failed','denied') THEN 'failed' ELSE 'pending' END,
 c.id,c.name,'agent',NULL,NULL
FROM ephor_mcp_operation o JOIN ephor_mcp_connection c ON c.id=o.connection_id
WHERE NOT EXISTS (SELECT 1 FROM ephor_activity a WHERE a.id=o.id);
ALTER TABLE ephor_mcp_client ADD COLUMN metadata_expires_at BIGINT NOT NULL DEFAULT 0;
