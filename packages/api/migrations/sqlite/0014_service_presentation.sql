ALTER TABLE ephor_service ADD COLUMN group_name TEXT;
ALTER TABLE ephor_service ADD COLUMN group_color TEXT NOT NULL DEFAULT 'neutral';
ALTER TABLE ephor_service ADD COLUMN component_names TEXT NOT NULL DEFAULT '{}';
UPDATE ephor_service SET group_name=name;
