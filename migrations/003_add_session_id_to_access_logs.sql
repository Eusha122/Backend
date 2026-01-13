-- Migration to add session_id to access_logs

ALTER TABLE access_logs 
ADD COLUMN session_id TEXT;

-- Optional: specific index for performance if table grows large
-- CREATE INDEX idx_access_logs_session_id ON access_logs(session_id);
