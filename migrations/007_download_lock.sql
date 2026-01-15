-- Add download lock tracking to rooms table
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS download_in_progress BOOLEAN DEFAULT FALSE;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS last_download_activity TIMESTAMP WITH TIME ZONE;
