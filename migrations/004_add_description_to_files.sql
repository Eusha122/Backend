-- Add description column to files table
ALTER TABLE files ADD COLUMN IF NOT EXISTS description TEXT;
